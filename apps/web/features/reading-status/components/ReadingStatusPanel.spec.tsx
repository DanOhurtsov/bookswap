/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { ReadingStatusPanel } from './ReadingStatusPanel'

/**
 * RS14 (10j.2): the viewer's own status control on the work page. `apiRequest` is replaced by a
 * tiny in-memory server, so "re-reading" means a fresh GET that returns what the last PUT stored.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function apiError(message: string): ApiRequestError {
  return new ApiRequestError(503, { code: 'INTERNAL_ERROR', message })
}

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

let stored: ReadingStatus
let wasBorrowed: boolean

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path !== '/me/reading-statuses/w-1') return Promise.reject(new Error(`unexpected ${path}`))

    if (options.method === 'PUT' && options.body !== undefined) {
      stored = options.body.status

      return Promise.resolve({ workId: 'w-1', status: stored })
    }

    return Promise.resolve({ workId: 'w-1', status: stored, wasBorrowed })
  })
}

function statusButton(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Мій статус читання' })).getByRole('button', {
    name,
  })
}

function puts(): unknown[] {
  return apiRequest.mock.calls.filter(
    ([, options]) => (options as RequestOptions | undefined)?.method === 'PUT',
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  stored = 'NOT_READ'
  wasBorrowed = false
  serve()
})

describe('ReadingStatusPanel (RS14)', () => {
  it('shows loading, then the default «Не читав» with no tag', async () => {
    render(<ReadingStatusPanel workId="w-1" />)

    expect(screen.getByText('Завантажую статус…')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Не читав' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(statusButton('Читаю')).toHaveAttribute('aria-pressed', 'false')
    expect(statusButton('Прочитано')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Була позичена')).not.toBeInTheDocument()
    expect(screen.getByText('Статус бачите лише ви.')).toBeInTheDocument()
  })

  it('changes to every status in turn and a fresh mount re-reads the saved value', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ReadingStatusPanel workId="w-1" />)

    await screen.findByRole('group', { name: 'Мій статус читання' })

    for (const [label, status] of [
      ['Читаю', 'READING'],
      ['Прочитано', 'READ'],
      ['Не читав', 'NOT_READ'],
    ] as const) {
      await user.click(statusButton(label))

      expect(await screen.findByText(`Збережено: «${label}».`)).toBeInTheDocument()
      expect(statusButton(label)).toHaveAttribute('aria-pressed', 'true')
      expect(apiRequest).toHaveBeenLastCalledWith('/me/reading-statuses/w-1', {
        method: 'PUT',
        body: { status },
        schema: expect.anything() as unknown,
      })
    }

    await user.click(statusButton('Прочитано'))
    await screen.findByText('Збережено: «Прочитано».')
    unmount()

    render(<ReadingStatusPanel workId="w-1" />)

    await waitFor(() => {
      expect(statusButton('Прочитано')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(apiRequest).toHaveBeenLastCalledWith('/me/reading-statuses/w-1', {
      schema: expect.anything() as unknown,
      signal: expect.any(AbortSignal) as unknown,
    })
  })

  it('clicking the current status sends nothing', async () => {
    const user = userEvent.setup()

    render(<ReadingStatusPanel workId="w-1" />)
    await user.click(await screen.findByRole('button', { name: 'Не читав' }))

    expect(puts()).toHaveLength(0)
  })

  it('locks the control while a save is in flight', async () => {
    const user = userEvent.setup()
    let finish: (value: unknown) => void = () => undefined

    render(<ReadingStatusPanel workId="w-1" />)
    await screen.findByRole('group', { name: 'Мій статус читання' })

    apiRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await user.click(statusButton('Читаю'))

    expect(screen.getByText('Зберігаю…')).toBeInTheDocument()
    expect(statusButton('Прочитано')).toBeDisabled()

    finish({ workId: 'w-1', status: 'READING' })

    expect(await screen.findByText('Збережено: «Читаю».')).toBeInTheDocument()
    expect(statusButton('Прочитано')).toBeEnabled()
  })

  it('a failed save keeps the confirmed status and a retry re-sends the attempted one', async () => {
    const user = userEvent.setup()

    render(<ReadingStatusPanel workId="w-1" />)
    await screen.findByRole('group', { name: 'Мій статус читання' })

    apiRequest.mockRejectedValueOnce(apiError('Сервер недоступний'))
    await user.click(statusButton('Прочитано'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступний')
    expect(statusButton('Не читав')).toHaveAttribute('aria-pressed', 'true')
    expect(statusButton('Прочитано')).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument()
    expect(stored).toBe('READ')
  })

  it('a failed load shows an error with a retry that loads the status', async () => {
    const user = userEvent.setup()

    apiRequest.mockRejectedValueOnce(apiError('Немає звʼязку'))
    render(<ReadingStatusPanel workId="w-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Немає звʼязку')
    expect(screen.queryByRole('group', { name: 'Мій статус читання' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('button', { name: 'Не читав' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('shows the «Була позичена» tag from wasBorrowed, independent of the status', async () => {
    const user = userEvent.setup()

    wasBorrowed = true
    render(<ReadingStatusPanel workId="w-1" />)

    expect(await screen.findByText('Була позичена')).toBeInTheDocument()

    await user.click(statusButton('Читаю'))
    await screen.findByText('Збережено: «Читаю».')

    expect(screen.getByText('Була позичена')).toBeInTheDocument()
  })

  it('asks only the viewer-scoped /me route — no user id is ever sent (R-8)', async () => {
    const user = userEvent.setup()

    render(<ReadingStatusPanel workId="w-1" />)
    await user.click(await screen.findByRole('button', { name: 'Читаю' }))
    await screen.findByText('Збережено: «Читаю».')

    for (const [path, options] of apiRequest.mock.calls as [string, RequestOptions?][]) {
      expect(path).toBe('/me/reading-statuses/w-1')
      expect(Object.keys(options?.body ?? {})).not.toContain('userId')
    }
  })
})
