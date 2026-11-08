/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MyHistoryEntry, MyHistoryResponse, NamedHistoryEntry } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { SessionState } from '@/app/lib/use-session'
import { watchHistory } from '@/features/library/own-library/own-library.test-helpers'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: jest.requireActual<
    typeof import('@/features/library/own-library/own-library.test-helpers')
  >('@/features/library/own-library/own-library.test-helpers').useAddressSearchParams,
}))

const mockSession: SessionState = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    handle: 'reader',
    city: null,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    friendsOfFriendsAccess: false,
    loanRequestsPaused: false,
    defaultLoanTermDays: null,
    ownerDueReminders: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const requestedPaths = () => apiRequest.mock.calls.map(([path]) => path as string)

function copyOf(id: string, title: string): MyHistoryEntry['copy'] {
  return {
    id: `copy-${id}`,
    status: 'AVAILABLE',
    condition: 'GOOD',
    edition: {
      id: `ed-${id}`,
      workId: `work-${id}`,
      translationId: null,
      textKind: 'ORIGINAL',
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: 'PAPERBACK',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
    work: {
      id: `work-${id}`,
      title,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
  }
}

const BORROWED_ENTRY: NamedHistoryEntry = {
  names: true,
  loanId: 'loan-1',
  owner: { id: 'user-marta', displayName: 'Марта', handle: 'marta', avatarUrl: null },
  borrower: { id: 'user-me', displayName: 'Я', handle: 'me-user', avatarUrl: null },
  status: 'RETURNED',
  isOverdue: false,
  origin: 'REQUESTED',
  guestEvidence: null,
  requestedAt: '2026-01-01T00:00:00.000Z',
  respondedAt: null,
  handedAt: '2026-01-05T00:00:00.000Z',
  returnedAt: '2026-02-01T00:00:00.000Z',
  dueAt: null,
}

const BORROWED: MyHistoryEntry = {
  entry: BORROWED_ENTRY,
  copy: copyOf('1', 'Позичена книга'),
  completedAt: '2026-02-01T00:00:00.000Z',
  latestFactAt: '2026-02-01T00:00:00.000Z',
}

/** My book Oles returned later, though he asked for it earlier than I asked Marta. */
const LENT: MyHistoryEntry = {
  entry: {
    names: true,
    loanId: 'loan-2',
    owner: { id: 'user-me', displayName: 'Я', handle: 'me-user', avatarUrl: null },
    borrower: { id: 'user-oles', displayName: 'Олесь', handle: 'oles', avatarUrl: null },
    status: 'RETURNED',
    isOverdue: false,
    origin: 'REQUESTED',
    guestEvidence: null,
    requestedAt: '2025-12-01T00:00:00.000Z',
    respondedAt: '2025-12-02T00:00:00.000Z',
    handedAt: '2025-12-03T00:00:00.000Z',
    returnedAt: '2026-03-01T00:00:00.000Z',
    dueAt: null,
  },
  copy: copyOf('2', 'Віддана книга'),
  completedAt: '2026-03-01T00:00:00.000Z',
  latestFactAt: '2026-03-01T00:00:00.000Z',
}

/** A request I cancelled: closed, but its ending was never recorded. */
const CANCELLED: MyHistoryEntry = {
  entry: {
    ...BORROWED_ENTRY,
    loanId: 'loan-3',
    status: 'CANCELLED',
    requestedAt: '2026-04-01T00:00:00.000Z',
    handedAt: null,
    returnedAt: null,
  },
  copy: copyOf('3', 'Скасований запит'),
  completedAt: null,
  latestFactAt: '2026-04-01T00:00:00.000Z',
}

/** A fact the owner recorded for a guest: the API sends it without names, contact or loan id. */
function toGuest(id: string, title: string): MyHistoryEntry {
  return {
    entry: {
      names: false,
      status: 'HANDED_OVER',
      isOverdue: false,
      origin: 'RECORDED_GUEST',
      guestEvidence: 'OWNER_STATEMENT',
      requestedAt: null,
      respondedAt: null,
      handedAt: '2026-03-01T00:00:00.000Z',
      returnedAt: null,
      dueAt: '2026-04-01',
    },
    copy: copyOf(id, title),
    completedAt: null,
    latestFactAt: '2026-03-01T00:00:00.000Z',
  }
}

const HISTORY: MyHistoryResponse = {
  borrowed: [CANCELLED, BORROWED],
  lent: [LENT, toGuest('4', 'Книга в гостя')],
}

let unwatchHistory: () => void = () => undefined

function openAt(search: string): void {
  window.history.replaceState(null, '', `/loans${search}`)
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue(HISTORY)
  mockReplace.mockReset()
  unwatchHistory = watchHistory()
  openAt('?tab=history')
})

afterEach(() => {
  unwatchHistory()
})

const historyTab = () => screen.getByRole('tab', { name: 'Історія' })

/** Each record is one link whose name starts with the book's title. */
const rows = async () =>
  (await within(screen.getByRole('tabpanel')).findAllByRole('listitem')).map((item) =>
    within(item).getByRole('link'),
  )
const titles = async () =>
  (await rows()).map((row) => row.getAttribute('aria-label')?.split(/[,.]/)[0])
const rowOf = async (title: string) =>
  (await rows()).find((row) =>
    row.getAttribute('aria-label')?.startsWith(`${title}.`),
  ) as HTMLElement

describe('LoansScreen ?tab=history: один спільний список (BS-142, BS-143, вигляд — BS-153)', () => {
  it('«Історія» показує один список без підвкладок і читає лише /me/history', async () => {
    render(<LoansScreen />)

    expect(historyTab()).toHaveAttribute('aria-selected', 'true')
    expect(await titles()).toHaveLength(4)
    expect(screen.getByText('4 позики')).toBeVisible()
    expect(screen.getAllByRole('tablist').map((list) => list.getAttribute('aria-label'))).toEqual([
      'Вкладки позичань',
    ])
    expect(screen.queryByRole('tab', { name: 'Що я брав' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Що в мене брали' })).not.toBeInTheDocument()
    expect(requestedPaths()).toEqual(['/me/history'])
  })

  it('напрямки перемішані за датою завершення; записи без неї — нижче, за останньою датою', async () => {
    render(<LoansScreen />)

    expect(await titles()).toEqual([
      'Віддана книга',
      'Позичена книга',
      'Скасований запит',
      'Книга в гостя',
    ])
  })

  it('рядок: напрямок, інший учасник, статус, фактичні дати й перехід до деталей позики', async () => {
    render(<LoansScreen />)

    const borrowed = await rowOf('Позичена книга')

    expect(borrowed).toHaveAttribute('href', '/loans?tab=history&loanId=loan-1')
    expect(borrowed).toHaveAccessibleName(
      'Позичена книга. Марта, ви позичили. Статус: Повернено. Попросили 1 січня 2026 р. ' +
        'Передано: 5 січня 2026 р. · Повернено: 1 лютого 2026 р. Переглянути позику',
    )
    expect(borrowed).toHaveTextContent('Ви позичили')
    expect(borrowed).not.toHaveTextContent('Завершено')
    expect(within(borrowed).getByText('Повернено')).toHaveClass('loan-badge--done')

    const lent = await rowOf('Віддана книга')

    expect(lent).toHaveTextContent('Олесь')
    expect(lent).toHaveTextContent('Ви дали почитати')
  })

  it('відсутні дати — «не вказано», дата запиту не підміняє ні передачу, ні завершення', async () => {
    render(<LoansScreen />)

    const cancelled = await rowOf('Скасований запит')

    expect(within(cancelled).getByText('Скасовано')).toHaveClass('loan-badge--done')
    expect(cancelled).toHaveTextContent(
      'Передано: не вказано · Повернено: не вказано · Завершено: не вказано',
    )
    expect(cancelled).toHaveTextContent('Попросили 1 квітня 2026 р.')
  })

  it('гостьовий запис лишається анонімним: без імен, alias чи контакту; строк — не дата повернення', async () => {
    render(<LoansScreen />)

    const guest = await rowOf('Книга в гостя')

    expect(guest).toHaveTextContent('Гість, ім’я не показується')
    expect(guest).toHaveTextContent('Ви дали почитати')
    expect(guest).toHaveTextContent('Записано власником · джерело: зі слів власника')
    expect(guest).toHaveTextContent('Строк повернення до 1 квітня 2026 р.')
    expect(guest).toHaveTextContent('Повернено: не вказано')
    expect(guest).not.toHaveTextContent(/Я у|гість:|контакт/i)
    // No loan id to open: the record leads to its copy's history, as it did before.
    expect(guest).toHaveAttribute('href', '/copies/copy-4/history')
    expect(guest).toHaveAccessibleName(/Переглянути історію примірника$/)
  })

  it('пошук знаходить іншу сторону за іменем, а гостя — ні: імені немає', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await titles()

    await user.type(screen.getByRole('searchbox', { name: 'Пошук позик' }), 'олесь')

    expect(await titles()).toEqual(['Віддана книга'])

    await user.clear(screen.getByRole('searchbox', { name: 'Пошук позик' }))
    await user.type(screen.getByRole('searchbox', { name: 'Пошук позик' }), 'гість')

    expect(await screen.findByRole('heading', { name: 'Нічого не знайдено' })).toBeVisible()
  })

  it('фільтр історії пропонує лише статуси, що завершують позику', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await titles()

    await user.click(screen.getByRole('combobox', { name: 'Статус' }))

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Усі статуси',
      'Відмовлено',
      'Скасовано',
      'Повернено',
      'Втрачено',
      'Відхилено позичальником',
    ])

    await user.click(screen.getByRole('option', { name: 'Скасовано' }))

    expect(await titles()).toEqual(['Скасований запит'])
    expect(new URLSearchParams(window.location.search).get('status')).toBe('CANCELLED')
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('history')
  })

  it('схожі анонімні записи й повторні позичання — окремі рядки', async () => {
    apiRequest.mockResolvedValue({
      borrowed: [BORROWED, { ...BORROWED, entry: { ...BORROWED_ENTRY, loanId: 'loan-1-again' } }],
      lent: [toGuest('4', 'Книга в гостя'), toGuest('4', 'Книга в гостя')],
    })

    render(<LoansScreen />)

    expect(await titles()).toEqual([
      'Позичена книга',
      'Позичена книга',
      'Книга в гостя',
      'Книга в гостя',
    ])
  })

  it.each(['borrowed', 'lent', 'other'])(
    'стара адреса ?tab=history&historyView=%s відкриває спільну історію й адресу не переписує',
    async (view) => {
      openAt(`?tab=history&historyView=${view}`)

      render(<LoansScreen />)

      expect(historyTab()).toHaveAttribute('aria-selected', 'true')
      expect(await titles()).toHaveLength(4)
      expect(window.location.search).toBe(`?tab=history&historyView=${view}`)
      expect(mockReplace).not.toHaveBeenCalled()
    },
  )

  it('порожні обидва напрямки — спільний порожній стан', async () => {
    apiRequest.mockResolvedValue({ borrowed: [], lent: [] })

    render(<LoansScreen />)

    expect(await screen.findByRole('heading', { name: 'Історія поки порожня' })).toBeVisible()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it.each([
    ['borrowed', { borrowed: [BORROWED], lent: [] }, 'Позичена книга'],
    ['lent', { borrowed: [], lent: [LENT] }, 'Віддана книга'],
  ])(
    'порожній один напрямок не робить історію порожньою (є лише %s)',
    async (_, history, title) => {
      apiRequest.mockResolvedValue(history)

      render(<LoansScreen />)

      expect(await titles()).toEqual([title])
      expect(screen.queryByText('Історія поки порожня')).not.toBeInTheDocument()
    },
  )

  it('поки історія вантажиться — стан завантаження', () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    render(<LoansScreen />)

    expect(
      within(screen.getByRole('tabpanel')).getByText('Завантажуємо позики…'),
    ).toBeInTheDocument()
  })

  it('помилка завантаження показується в панелі, без порожнього стану', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )

    render(<LoansScreen />)

    expect(await screen.findByText(/Сервер недоступний/)).toBeVisible()
    expect(screen.queryByText('Історія поки порожня')).not.toBeInTheDocument()
  })

  it('клавіатура: навігація розділу → вкладка → пошук → статус → «Нова позика» → панель → перший рядок', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await titles()

    // The section navigation stands above the tabs: three links, each its own Tab stop.
    for (const name of ['Книжки', 'Позичання', 'Вішлист']) {
      await user.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }

    await user.tab()
    expect(historyTab()).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('searchbox', { name: 'Пошук позик' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Статус' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Нова позика' })).toHaveFocus()

    // The open panel is its own Tab stop; the first row comes right inside it.
    await user.tab()
    expect(screen.getByRole('tabpanel')).toHaveFocus()
    await user.tab()
    expect((await rows())[0]).toHaveFocus()
  })

  it('стрілка й Enter з «Історії» ведуть на поточну вкладку й лишають на ній фокус', async () => {
    const user = userEvent.setup()

    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(path === '/me/history' ? HISTORY : { loans: [] }),
    )

    render(<LoansScreen />)
    await titles()

    historyTab().focus()
    await user.keyboard('{ArrowLeft}{Enter}')

    expect(await screen.findByRole('heading', { name: 'Тут поки немає позик' })).toBeVisible()
    expect(window.location.search).toBe('?role=owner')
    expect(screen.getByRole('tab', { name: /^У мене позичають/ })).toHaveFocus()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
