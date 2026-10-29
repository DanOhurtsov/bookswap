/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MyHistoryEntry, MyHistoryResponse, NamedHistoryEntry } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { SessionState } from '@/app/lib/use-session'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
let mockParameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => mockParameters,
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

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue(HISTORY)
  mockReplace.mockReset()
  mockParameters = new URLSearchParams('tab=history')
})

const historyList = () => screen.findByRole('list', { name: 'Історія позичань' })

const titles = async () =>
  within(await historyList())
    .getAllByRole('listitem')
    .map((item) => within(item).getAllByRole('link')[0]?.textContent)

const cardOf = async (title: string) =>
  (await screen.findByRole('link', { name: title })).closest('li') as HTMLElement

describe('LoansScreen ?tab=history: один спільний список (BS-142, BS-143)', () => {
  it('«Історія» показує один список без підвкладок і читає лише /me/history', async () => {
    render(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveAttribute('aria-selected', 'true')
    expect(await titles()).toHaveLength(4)
    expect(screen.getAllByRole('tablist').map((list) => list.getAttribute('aria-label'))).toEqual([
      'Вкладки позичань',
    ])
    expect(screen.queryByRole('tab', { name: 'Що я брав' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Що в мене брали' })).not.toBeInTheDocument()
    expect(requestedPaths()).toEqual(['/me/history'])
    expect(screen.queryByLabelText('Статус')).not.toBeInTheDocument()
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

  it('картка: напрямок, інший учасник, фактичні дати, статус, посилання на твір і історію примірника', async () => {
    render(<LoansScreen />)

    const borrowed = await cardOf('Позичена книга')

    expect(borrowed).toHaveTextContent('Ви позичили · Власник: Марта')
    expect(borrowed).toHaveTextContent('Статус: Повернено')
    expect(borrowed).toHaveTextContent(/Передано: 5 січня 2026 р\. · Повернено: 1 лютого 2026 р\./)
    expect(borrowed).toHaveTextContent('Попросили 1 січня 2026 р.')
    expect(borrowed).not.toHaveTextContent('Завершено')
    expect(within(borrowed).getByRole('link', { name: 'Позичена книга' })).toHaveAttribute(
      'href',
      '/works/work-1',
    )
    expect(within(borrowed).getByRole('link', { name: 'Уся історія примірника' })).toHaveAttribute(
      'href',
      '/copies/copy-1/history',
    )

    expect(await cardOf('Віддана книга')).toHaveTextContent('Ви дали почитати · Позичальник: Олесь')
  })

  it('відсутні дати — «не вказано», дата запиту не підміняє ні передачу, ні завершення', async () => {
    render(<LoansScreen />)

    const cancelled = await cardOf('Скасований запит')

    expect(cancelled).toHaveTextContent('Статус: Скасовано')
    expect(cancelled).toHaveTextContent(
      'Передано: не вказано · Повернено: не вказано · Завершено: не вказано',
    )
    expect(cancelled).toHaveTextContent('Попросили 1 квітня 2026 р.')
  })

  it('гостьовий запис лишається анонімним: без імен, alias чи контакту; строк — не дата повернення', async () => {
    render(<LoansScreen />)

    const guest = await cardOf('Книга в гостя')

    expect(guest).toHaveTextContent('Ви дали почитати · Позичальник: гість, ім’я не показується')
    expect(guest).toHaveTextContent('Записано власником · джерело: зі слів власника')
    expect(guest).toHaveTextContent('строк повернення до 1 квітня 2026 р.')
    expect(guest).toHaveTextContent('Повернено: не вказано')
    expect(guest).not.toHaveTextContent(/Я у|гість:|контакт/i)
    expect(within(guest).getByRole('link', { name: 'Уся історія примірника' })).toHaveAttribute(
      'href',
      '/copies/copy-4/history',
    )
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
      mockParameters = new URLSearchParams(`tab=history&historyView=${view}`)

      render(<LoansScreen />)

      expect(screen.getByRole('tab', { name: 'Історія' })).toHaveAttribute('aria-selected', 'true')
      expect(await titles()).toHaveLength(4)
      expect(mockReplace).not.toHaveBeenCalled()
    },
  )

  it('порожні обидва напрямки — спільний порожній стан', async () => {
    apiRequest.mockResolvedValue({ borrowed: [], lent: [] })

    render(<LoansScreen />)

    expect(await screen.findByText('Історія позичань поки порожня.')).toBeVisible()
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
      expect(screen.queryByText('Історія позичань поки порожня.')).not.toBeInTheDocument()
    },
  )

  it('поки історія вантажиться — стан завантаження', () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    render(<LoansScreen />)

    expect(within(screen.getByRole('tabpanel')).getByText('Завантажую…')).toBeVisible()
  })

  it('помилка завантаження показується в панелі, без порожнього стану', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )

    render(<LoansScreen />)

    expect(await screen.findByText(/Сервер недоступний/)).toBeVisible()
    expect(screen.queryByText('Історія позичань поки порожня.')).not.toBeInTheDocument()
  })

  it('клавіатура: навігація розділу → «Історія» → панель → перша книжка; стрілка й Enter ведуть на іншу вкладку', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await historyList()

    // The section navigation stands above the tabs: three links, each its own Tab stop.
    for (const name of ['Книжки', 'Позичання', 'Вішлист']) {
      await user.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }

    await user.tab()
    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveFocus()

    // The open panel is its own Tab stop; the first card's title comes right inside it.
    await user.tab()
    expect(screen.getByRole('tabpanel')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Віддана книга' })).toHaveFocus()

    await user.tab({ shift: true })
    await user.tab({ shift: true })
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Я позичаю' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(mockReplace).toHaveBeenCalledWith('/loans?role=borrower')
  })
})
