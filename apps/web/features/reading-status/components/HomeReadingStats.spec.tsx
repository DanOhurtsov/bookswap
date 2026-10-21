/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReadingStatsResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import type { ReadingStatsSnapshot } from '../model/reading-stats-view'
import { readingStatsQueryKey } from '../model/use-reading-stats'
import { HomeReadingStats } from './HomeReadingStats'

/**
 * BS-145: the reading stats block of the home page, by role and text. `apiRequest` and the session
 * are replaced; how the block follows saves and account changes is in `HomeReadingStats.sync.spec`.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let session: SessionState

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: session }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const STATS_PATH = '/me/reading-stats'
const SECTION = 'Моє читання'

const stats = (NOT_READ: number, READING: number, READ: number): ReadingStatsResponse => ({
  counts: { NOT_READ, READING, READ },
})

function signedIn(id: string): SessionState {
  return { status: 'authenticated', user: { id } } as SessionState
}

function statsRequests(): unknown[] {
  return apiRequest.mock.calls.filter(([path]) => path === STATS_PATH)
}

function section(): HTMLElement {
  return screen.getByRole('region', { name: SECTION })
}

/** The count shown beside a status label. */
function countOf(label: string): string | null | undefined {
  return within(section()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
}

function renderStats(initial: ReadingStatsSnapshot, client = createTestQueryClient()) {
  return { client, ...render(withQueryClient(<HomeReadingStats initial={initial} />, client)) }
}

beforeEach(() => {
  apiRequest.mockReset()
  session = signedIn('me')
})

describe('HomeReadingStats (BS-145)', () => {
  it('shows all three statuses with their counts, a zero included', async () => {
    apiRequest.mockResolvedValue(stats(3, 0, 5))

    renderStats({ status: 'error' })

    await waitFor(() => {
      expect(countOf('Не читав')).toBe('3')
    })
    expect(countOf('Читаю')).toBe('0')
    expect(countOf('Прочитано')).toBe('5')
    expect(screen.getByText(/Статистику бачите лише ви/)).toBeInTheDocument()
  })

  it('says it is counting while the first answer is on its way', async () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    renderStats({ status: 'error' })

    expect(section()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Рахую ваші статуси читання…')).toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(statsRequests()).toHaveLength(1)
    })
  })

  it('a failed read is an alert with a retry, never zeros; the retry asks once more', async () => {
    const user = userEvent.setup()

    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )
    renderStats({ status: 'error' })

    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('Не вдалося завантажити статистику читання. Сервер недоступний')
    expect(within(section()).queryByText('Не читав')).not.toBeInTheDocument()
    expect(within(section()).queryByText('0')).not.toBeInTheDocument()
    expect(statsRequests()).toHaveLength(1)

    apiRequest.mockResolvedValueOnce(stats(0, 1, 0))
    await user.click(within(alert).getByRole('button', { name: 'Спробувати ще раз' }))

    await waitFor(() => {
      expect(countOf('Читаю')).toBe('1')
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(statsRequests()).toHaveLength(2)
  })

  it('no status set at all: an empty state that leads to the library', async () => {
    apiRequest.mockResolvedValue(stats(0, 0, 0))

    renderStats({ status: 'error' })

    expect(await screen.findByText(/Ви ще не позначили жодного твору/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Перейти до бібліотеки' })).toHaveAttribute(
      'href',
      '/library',
    )
    expect(within(section()).queryByText('Не читав')).not.toBeInTheDocument()
  })

  it('a guest sees no block and sends no request', () => {
    session = { status: 'guest' }

    const { container } = renderStats({ status: 'guest' })

    expect(container).toBeEmptyDOMElement()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('a session that cannot be read shows no block and sends no request', () => {
    session = { status: 'error', message: 'Сесію не прочитано' }

    const { container } = renderStats({ status: 'error' })

    expect(container).toBeEmptyDOMElement()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  describe('the server snapshot', () => {
    it('waits for the session to name its user: neither shown nor cached, and nothing is asked', () => {
      session = { status: 'loading' }

      const { client } = renderStats({ status: 'ready', userId: 'me', data: stats(1, 2, 3) })

      expect(screen.getByText('Рахую ваші статуси читання…')).toBeInTheDocument()
      expect(screen.queryByText('3')).not.toBeInTheDocument()
      expect(apiRequest).not.toHaveBeenCalled()
      expect(client.getQueryCache().getAll()).toEqual([])
    })

    it('a guest snapshot shows nothing while the session is confirmed', () => {
      session = { status: 'loading' }

      const { container } = renderStats({ status: 'guest' })

      expect(container).toBeEmptyDOMElement()
    })

    it('seeds the cache of the user it was read for, without asking again', () => {
      const { client } = renderStats({ status: 'ready', userId: 'me', data: stats(1, 2, 3) })

      expect(countOf('Читаю')).toBe('2')
      expect(statsRequests()).toEqual([])
      expect(client.getQueryData(readingStatsQueryKey('me'))).toEqual(stats(1, 2, 3))
    })

    it('read for another user is never shown nor cached: the viewer’s own counts are read', async () => {
      apiRequest.mockResolvedValue(stats(0, 0, 9))

      const { client } = renderStats({
        status: 'ready',
        userId: 'someone-else',
        data: stats(7, 7, 7),
      })

      expect(screen.queryByText('7')).not.toBeInTheDocument()
      await waitFor(() => {
        expect(countOf('Прочитано')).toBe('9')
      })
      expect(screen.queryByText('7')).not.toBeInTheDocument()
      expect(client.getQueryData(readingStatsQueryKey('someone-else'))).toBeUndefined()
    })

    it('never overwrites counts already in the cache', () => {
      const client = createTestQueryClient()

      client.setQueryData(readingStatsQueryKey('me'), stats(0, 0, 2))
      renderStats({ status: 'ready', userId: 'me', data: stats(0, 0, 1) }, client)

      expect(countOf('Прочитано')).toBe('2')
      expect(client.getQueryData(readingStatsQueryKey('me'))).toEqual(stats(0, 0, 2))
    })
  })
})
