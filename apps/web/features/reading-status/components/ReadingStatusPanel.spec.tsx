/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import { ReadingStatusPanel } from './ReadingStatusPanel'

/**
 * RS14 (10j.2), BS-140: the viewer's own status control on the work and own-book pages. `apiRequest`
 * is replaced by a tiny in-memory server, so "re-reading" means a fresh GET that returns what the
 * last PUT stored. BS-140 replaced the three `aria-pressed` buttons with one select; the checks of
 * saving, failure, retry and privacy are the same ones.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: { status: 'authenticated', user: { id: 'me' } } }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const FIELD = 'Мій статус читання'

function apiError(message: string): ApiRequestError {
  return new ApiRequestError(503, { code: 'INTERNAL_ERROR', message })
}

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

/** `null` — no row at all. */
let stored: ReadingStatus | null
let wasBorrowed: boolean

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path !== '/me/reading-statuses/w-1') return Promise.reject(new Error(`unexpected ${path}`))

    if (options.method === 'PUT' && options.body !== undefined) {
      stored = options.body.status

      return Promise.resolve({ workId: 'w-1', status: stored })
    }

    return Promise.resolve({
      workId: 'w-1',
      status: stored ?? 'NOT_READ',
      isSet: stored !== null,
      wasBorrowed,
    })
  })
}

function field(): HTMLElement {
  return screen.getByRole('combobox', { name: FIELD })
}

function puts(): unknown[] {
  return apiRequest.mock.calls.filter(
    ([, options]) => (options as RequestOptions | undefined)?.method === 'PUT',
  )
}

function renderPanel(): ReturnType<typeof render> {
  return render(withQueryClient(<ReadingStatusPanel workId="w-1" />))
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  stored = null
  wasBorrowed = false
  serve()
})

describe('ReadingStatusPanel (RS14, BS-140)', () => {
  it('without a row shows loading, then «Вказати статус читання» — not «Не читав» — and no tag', async () => {
    renderPanel()

    expect(screen.getByText('Завантажую статус…')).toBeInTheDocument()
    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent(
      'Вказати статус читання',
    )
    expect(field()).not.toHaveTextContent('Не читав')
    expect(screen.queryByText('Була позичена')).not.toBeInTheDocument()
    expect(screen.getByText('Статус бачите лише ви.')).toBeInTheDocument()
  })

  it('an explicit NOT_READ shows «Не читав»', async () => {
    stored = 'NOT_READ'
    renderPanel()

    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent('Не читав')
  })

  it('choosing «Не читав» with nothing set sends it (BS-140: it creates the record)', async () => {
    const user = userEvent.setup()

    renderPanel()
    await chooseOption(user, FIELD, 'Не читав')

    expect(await screen.findByText('Збережено: «Не читав».')).toBeInTheDocument()
    expect(field()).toHaveTextContent('Не читав')
    expect(apiRequest).toHaveBeenLastCalledWith('/me/reading-statuses/w-1', {
      method: 'PUT',
      body: { status: 'NOT_READ' },
      schema: expect.anything() as unknown,
    })
  })

  it('changes to every status in turn and a fresh mount re-reads the saved value', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPanel()

    for (const [label, status] of [
      ['Читаю', 'READING'],
      ['Прочитано', 'READ'],
      ['Не читав', 'NOT_READ'],
      ['Прочитано', 'READ'],
    ] as const) {
      await chooseOption(user, FIELD, label)

      expect(await screen.findByText(`Збережено: «${label}».`)).toBeInTheDocument()
      expect(field()).toHaveTextContent(label)
      expect(apiRequest).toHaveBeenLastCalledWith('/me/reading-statuses/w-1', {
        method: 'PUT',
        body: { status },
        schema: expect.anything() as unknown,
      })
    }

    unmount()
    // A new client is a new page load: nothing is cached, so the value comes from a fresh GET.
    renderPanel()

    await waitFor(() => {
      expect(field()).toHaveTextContent('Прочитано')
    })
    expect(apiRequest).toHaveBeenLastCalledWith('/me/reading-statuses/w-1', {
      schema: expect.anything() as unknown,
    })
  })

  it('choosing the current status sends nothing', async () => {
    const user = userEvent.setup()

    stored = 'READING'
    renderPanel()
    await chooseOption(user, FIELD, 'Читаю')

    expect(puts()).toHaveLength(0)
  })

  // Choosing with Enter needs `PointerEvent`, which jsdom lacks: that step is checked in a real browser
  // (`reading-status-controls.browser-spec.ts`). Here: focus, open, close, and nothing sent.
  it('is reachable from the keyboard: Tab focuses it, ArrowDown opens the list, Escape returns focus', async () => {
    const user = userEvent.setup()

    renderPanel()
    await screen.findByRole('combobox', { name: FIELD })

    await user.tab()
    expect(field()).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Не читав',
      'Читаю',
      'Прочитано',
    ])

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
    expect(field()).toHaveFocus()
    expect(puts()).toHaveLength(0)
  })

  it('locks the control while a save is in flight', async () => {
    const user = userEvent.setup()
    let finish: (value: unknown) => void = () => undefined

    renderPanel()
    await screen.findByRole('combobox', { name: FIELD })

    apiRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await chooseOption(user, FIELD, 'Читаю')

    expect(screen.getByText('Зберігаю…')).toBeInTheDocument()
    expect(field()).toHaveAttribute('data-disabled')

    finish({ workId: 'w-1', status: 'READING' })

    expect(await screen.findByText('Збережено: «Читаю».')).toBeInTheDocument()
    expect(field()).not.toHaveAttribute('data-disabled')
  })

  it('a failed save keeps the confirmed status and a retry re-sends the attempted one', async () => {
    const user = userEvent.setup()

    stored = 'NOT_READ'
    renderPanel()
    await screen.findByRole('combobox', { name: FIELD })

    apiRequest.mockRejectedValueOnce(apiError('Сервер недоступний'))
    await chooseOption(user, FIELD, 'Прочитано')

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступний')
    expect(field()).toHaveTextContent('Не читав')

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument()
    expect(stored).toBe('READ')
  })

  it('a failed load shows an error, not «not set», with a retry that loads the status', async () => {
    const user = userEvent.setup()

    apiRequest.mockRejectedValueOnce(apiError('Немає звʼязку'))
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('Немає звʼязку')
    expect(screen.queryByRole('combobox', { name: FIELD })).not.toBeInTheDocument()
    expect(screen.queryByText('Вказати статус читання')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent(
      'Вказати статус читання',
    )
  })

  it('shows the «Була позичена» tag from wasBorrowed, independent of the status', async () => {
    const user = userEvent.setup()

    wasBorrowed = true
    renderPanel()

    expect(await screen.findByText('Була позичена')).toBeInTheDocument()

    await chooseOption(user, FIELD, 'Читаю')
    await screen.findByText('Збережено: «Читаю».')

    expect(screen.getByText('Була позичена')).toBeInTheDocument()
  })

  it('asks only the viewer-scoped /me route — no user id is ever sent (R-8)', async () => {
    const user = userEvent.setup()

    renderPanel()
    await chooseOption(user, FIELD, 'Читаю')
    await screen.findByText('Збережено: «Читаю».')

    for (const [path, options] of apiRequest.mock.calls as [string, RequestOptions?][]) {
      expect(path).toBe('/me/reading-statuses/w-1')
      expect(Object.keys(options?.body ?? {})).not.toContain('userId')
    }
  })
})
