/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ApiRequestError } from '@/app/lib/api'
import type {
  Edition,
  HistoryEntry,
  Work,
  WorkAuthor,
  WorkDetailResponse,
  WorkHistoryResponse,
  WorkHoldersResponse,
} from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import WorkPage from './page'

/**
 * RS14/RS15 (10j.2) on the real work page: the viewer's own status next to the unchanged
 * holders block and the transfer history renamed «Хто брав цю книжку» (Q16). Only the HTTP
 * client is mocked; the panels are real. BS-140: the status is one select instead of three
 * `aria-pressed` buttons — the same checks, read from the select.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

// Read on every render, so a test can switch the signed-in user under a mounted page.
let sessionUserId = 'me'

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: {
      status: 'authenticated',
      user: { id: sessionUserId, name: 'Тест', email: 't@example.com' },
    },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'w-1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const { apiRequest, apiRequestWithRedirect } = jest.requireMock<{
  apiRequest: jest.Mock
  apiRequestWithRedirect: jest.Mock
}>('@/app/lib/api')

function apiError(message: string): ApiRequestError {
  return new ApiRequestError(503, { code: 'INTERNAL_ERROR', message })
}

const work: Work = {
  id: 'w-1',
  title: 'Лісова пісня',
  origLang: 'uk',
  firstPubYear: 1911,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

const authors: WorkAuthor[] = [
  { id: 'a-1', name: 'Леся Українка', nameLatin: null, role: 'AUTHOR', position: 0 },
]

const edition: Edition = {
  id: 'e-1',
  workId: 'w-1',
  translationId: null,
  textKind: 'ORIGINAL',
  lang: 'uk',
  translator: null,
  publisher: 'Абабагаламага',
  year: 2020,
  isbn13: null,
  format: 'HARDCOVER',
  pageCount: null,
  coverUrl: null,
  revision: 1,
}

const friend = { id: 'f-1', displayName: 'Олена', handle: 'f-1', avatarUrl: null }
const owner = { id: 'o-1', displayName: 'Тарас', handle: 'taras', avatarUrl: null }

function entry(loanId: string, status: 'HANDED_OVER' | 'RETURNED'): HistoryEntry {
  return {
    names: true,
    loanId,
    owner,
    borrower: friend,
    status,
    isOverdue: false,
    origin: 'REQUESTED',
    guestEvidence: null,
    requestedAt: '2026-03-01T10:00:00.000Z',
    respondedAt: '2026-03-02T10:00:00.000Z',
    handedAt: '2026-03-03T10:00:00.000Z',
    returnedAt: status === 'RETURNED' ? '2026-03-10T10:00:00.000Z' : null,
    dueAt: null,
  }
}

const history: WorkHistoryResponse = {
  work,
  authors,
  entries: [
    { entry: entry('l-now', 'HANDED_OVER'), copyId: 'c-1', edition },
    { entry: entry('l-past', 'RETURNED'), copyId: 'c-1', edition },
  ],
}

const holders: WorkHoldersResponse = {
  workId: 'w-1',
  groups: [
    {
      translationId: null,
      textKind: 'ORIGINAL',
      language: 'uk',
      translator: null,
      owners: [{ owner, relation: 'FRIEND', availableCopies: 0, copies: [] }],
    },
  ],
}

const detail: WorkDetailResponse = { work, authors, translations: [], editions: [] }

let statusFails: boolean

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  statusFails = false
  sessionUserId = 'me'

  apiRequestWithRedirect.mockImplementation((path: string) =>
    Promise.resolve({
      data: path === '/works/w-1/holders' ? holders : detail,
      redirected: false,
    }),
  )

  apiRequest.mockImplementation(
    (path: string, options?: { method?: string; body?: { status: string } }) => {
      if (path === '/works/w-1/history') return Promise.resolve(history)
      if (path === '/me/wishlist') return Promise.resolve({ items: [] })

      if (path === '/me/reading-statuses/w-1') {
        if (statusFails) return Promise.reject(apiError('Статус недоступний'))
        if (options?.method === 'PUT')
          return Promise.resolve({ workId: 'w-1', status: options.body?.status })

        return Promise.resolve({
          workId: 'w-1',
          status: 'NOT_READ',
          isSet: true,
          wasBorrowed: true,
        })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    },
  )
})

const FIELD = 'Мій статус читання'

function section(heading: string): HTMLElement {
  return screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement
}

describe('Work page: own reading status and «Хто брав цю книжку» (RS14, RS15, Q16)', () => {
  it('names the history «Хто брав цю книжку», keeps «Хто має цю книжку?» and both current and past loans', async () => {
    render(withQueryClient(<WorkPage />))

    const historyHeading = await screen.findByRole('heading', { name: 'Хто брав цю книжку' })
    const historySection = historyHeading.closest('section') as HTMLElement

    expect(screen.queryByText('Хто з друзів це читав')).not.toBeInTheDocument()
    expect(await within(historySection).findByText(/На руках · Олена у Тарас/)).toBeInTheDocument()
    expect(within(historySection).getByText(/Повернено · Олена у Тарас/)).toBeInTheDocument()

    expect(await screen.findByRole('link', { name: 'Тарас' })).toHaveAttribute('href', '/u/taras')
    expect(section('Хто має цю книжку?')).toBeInTheDocument()

    // The history API is untouched: same path, no reading fields on it (R-8).
    expect(apiRequest).toHaveBeenCalledWith('/works/w-1/history', expect.anything())
    expect(within(historySection).queryByText(/Прочитано|Читаю|Не читав|Була позичена/)).toBeNull()
  })

  it('shows exactly one status control — the viewer’s own — with the tag, and saves a change', async () => {
    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent('Не читав')
    expect(screen.getAllByRole('combobox', { name: FIELD })).toHaveLength(1)
    expect(within(section('Мій статус читання')).getByText('Була позичена')).toBeInTheDocument()

    await chooseOption(user, FIELD, 'Прочитано')

    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: FIELD })).toHaveTextContent('Прочитано')
    expect(apiRequest).toHaveBeenCalledWith('/me/reading-statuses/w-1', {
      method: 'PUT',
      body: { status: 'READ' },
      schema: expect.anything() as unknown,
    })

    // Every reading-status request is the viewer-scoped /me route.
    const readingPaths = apiRequest.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.includes('reading'))

    expect(readingPaths.every((path) => path === '/me/reading-statuses/w-1')).toBe(true)
  })

  it('a status that fails to load does not break the rest of the page', async () => {
    statusFails = true

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('heading', { name: 'Лісова пісня' })).toBeInTheDocument()
    expect(await within(section('Мій статус читання')).findByRole('alert')).toHaveTextContent(
      'Статус недоступний',
    )
    expect(
      within(section('Мій статус читання')).getByRole('button', { name: 'Спробувати ще раз' }),
    ).toBeInTheDocument()

    const historySection = section('Хто брав цю книжку')

    expect(await within(historySection).findByText(/На руках · Олена у Тарас/)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Тарас' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Видання' })).toBeInTheDocument()
  })
  it('a session switch A → B drops A’s status, tag and pending save at once and reads B’s own', async () => {
    const user = userEvent.setup()
    const statusRequestsBy: string[] = []
    let settleB: (value: unknown) => void = () => undefined
    let settleSaveA: (value: unknown) => void = () => undefined

    sessionUserId = 'a'

    // Answered for the session current WHEN the request is sent — like the cookie would be.
    apiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/works/w-1/history') return Promise.resolve(history)
      if (path === '/me/wishlist') return Promise.resolve({ items: [] })

      if (path === '/me/reading-statuses/w-1') {
        if (options?.method === 'PUT')
          return new Promise((resolve) => {
            settleSaveA = resolve
          })

        statusRequestsBy.push(sessionUserId)

        return sessionUserId === 'a'
          ? Promise.resolve({ workId: 'w-1', status: 'READ', isSet: true, wasBorrowed: true })
          : new Promise((resolve) => {
              settleB = resolve
            })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    })

    const { rerender } = render(withQueryClient(<WorkPage />))
    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent('Прочитано')
    expect(within(section('Мій статус читання')).getByText('Була позичена')).toBeInTheDocument()

    // A starts a save that is still in flight when the identity changes.
    await chooseOption(user, FIELD, 'Читаю')
    expect(screen.getByText('Зберігаю…')).toBeInTheDocument()

    sessionUserId = 'b'
    rerender(withQueryClient(<WorkPage />))

    // Before B's answer: none of A's status, tag or save state is on screen.
    const panel = section('Мій статус читання')

    expect(within(panel).getByText('Завантажую статус…')).toBeInTheDocument()
    expect(within(panel).queryByRole('combobox', { name: FIELD })).toBeNull()
    expect(within(panel).queryByText('Була позичена')).toBeNull()
    expect(within(panel).queryByText('Зберігаю…')).toBeNull()
    await waitFor(() => {
      expect(statusRequestsBy).toEqual(['a', 'b'])
    })

    // A's late save answer must not surface under B.
    await act(async () => {
      settleSaveA({ workId: 'w-1', status: 'READING' })
      settleB({ workId: 'w-1', status: 'NOT_READ', isSet: true, wasBorrowed: false })
      await Promise.resolve()
    })

    expect(await screen.findByRole('combobox', { name: FIELD })).toHaveTextContent('Не читав')
    expect(screen.getByRole('combobox', { name: FIELD })).not.toHaveTextContent('Читаю')
    expect(screen.queryByText(/Збережено/)).toBeNull()
    expect(within(section('Мій статус читання')).queryByText('Була позичена')).toBeNull()
  })
})
