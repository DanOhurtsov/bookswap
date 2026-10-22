/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
const mockPush = jest.fn()
let mockParameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockParameters,
}))

const SIGNED_IN: Extract<SessionState, { status: 'authenticated' }> = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

let mockSession: SessionState = SIGNED_IN

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const requestedPaths = () => apiRequest.mock.calls.map(([path]) => path as string)

const BORROWED_LOAN: Loan = {
  id: 'loan-7',
  status: 'HANDED_OVER',
  isOverdue: false,
  message: null,
  responseNote: null,
  origin: 'REQUESTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  requestedAt: '2026-01-01T00:00:00.000Z',
  respondedAt: '2026-01-02T00:00:00.000Z',
  handedAt: '2026-01-03T00:00:00.000Z',
  returnedAt: null,
  dueAt: null,
  owner: { id: 'user-marta', displayName: 'Марта', avatarUrl: null },
  borrower: { id: 'user-me', displayName: 'Я', avatarUrl: null },
  copy: { id: 'copy-7', status: 'LENT_OUT', condition: 'GOOD', isArchived: false },
  edition: {
    id: 'ed-7',
    workId: 'work-7',
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
    id: 'work-7',
    title: 'Книга на руках',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  recovery: null,
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue({ loans: [] })
  mockReplace.mockReset()
  mockPush.mockReset()
  mockParameters = new URLSearchParams()
  mockSession = SIGNED_IN
})

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent)
const loansTablist = () => screen.getByRole('tablist', { name: 'Вкладки позичань' })

describe('LoansScreen: вкладки «Мої книжки» / «Я позичаю» / «Історія» (BS-87, BS-143)', () => {
  it('без ?role= обрано «Мої книжки», і панель показує порожній стан власника', async () => {
    render(<LoansScreen />)

    expect(tabNames()).toEqual(['Мої книжки', 'Я позичаю', 'Історія'])
    expect(screen.getByRole('tab', { name: 'Мої книжки' })).toHaveAttribute('aria-selected', 'true')
    expect(
      await screen.findByText(/Вашими книжками поки ніхто не цікавився/, {
        selector: '[role="tabpanel"] *',
      }),
    ).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans?role=owner'])
  })

  it('?role=borrower відкриває «Я позичаю» і запитує саме цей бік', async () => {
    mockParameters = new URLSearchParams('role=borrower')

    render(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Я позичаю' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText(/Ви поки нічого не позичали й не просили/)).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans?role=borrower'])
  })

  it('невідомі ?role= і ?tab= падають на «Мої книжки»', async () => {
    mockParameters = new URLSearchParams('role=nobody&tab=archive')

    render(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Мої книжки' })).toHaveAttribute('aria-selected', 'true')
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)
    expect(requestedPaths()).toEqual(['/loans?role=owner'])
  })

  it('вкладка міняє ?role= через replace і зберігає решту параметрів', async () => {
    mockParameters = new URLSearchParams('status=REQUESTED')

    render(<LoansScreen />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    await userEvent.click(screen.getByRole('tab', { name: 'Я позичаю' }))

    expect(mockReplace).toHaveBeenCalledWith('/loans?status=REQUESTED&role=borrower')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('«Історія» ставить tab=history через replace і зберігає решту параметрів', async () => {
    mockParameters = new URLSearchParams('role=borrower&status=REQUESTED')

    render(<LoansScreen />)
    await screen.findByText(/Ви поки нічого не позичали й не просили/)

    await userEvent.click(screen.getByRole('tab', { name: 'Історія' }))

    expect(mockReplace).toHaveBeenCalledWith('/loans?role=borrower&status=REQUESTED&tab=history')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('з історії перша вкладка прибирає tab і ставить role', async () => {
    mockParameters = new URLSearchParams('tab=history&historyView=lent')
    apiRequest.mockResolvedValue({ borrowed: [], lent: [] })

    render(<LoansScreen />)
    await screen.findByText('У вас поки нічого не брали.')

    await userEvent.click(screen.getByRole('tab', { name: 'Мої книжки' }))

    expect(mockReplace).toHaveBeenCalledWith('/loans?historyView=lent&role=owner')
  })

  it('зміна адреси на тому самому маршруті перемикає активну вкладку й завантажує лише її дані', async () => {
    const { rerender } = render(<LoansScreen />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    apiRequest.mockResolvedValue({ borrowed: [], lent: [] })
    mockParameters = new URLSearchParams('tab=history')
    rerender(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Ви поки нічого не брали.')).toBeVisible()
    expect(screen.queryByLabelText('Статус')).not.toBeInTheDocument()

    apiRequest.mockResolvedValue({ loans: [] })
    mockParameters = new URLSearchParams('role=borrower')
    rerender(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Я позичаю' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText(/Ви поки нічого не позичали й не просили/)).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans?role=owner', '/me/history', '/loans?role=borrower'])
  })
})

describe('LoansScreen: вхід у «Гостьові позики» (BS-104)', () => {
  it('за ввімкненого guestLoans посилання стоїть над вкладками й веде на /loans/guest', async () => {
    mockSession = { ...SIGNED_IN, features: { guestLoans: true } }

    render(<LoansScreen />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    const link = screen.getByRole('link', { name: 'Гостьові позики' })

    expect(link).toHaveAttribute('href', '/loans/guest')
    expect(link.compareDocumentPosition(loansTablist())).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it.each([
    ['guestLoans=false', { guestLoans: false }],
    ['features unknown', undefined],
  ])('без прапора (%s) посилання немає', async (_name, features) => {
    mockSession = { ...SIGNED_IN, ...(features === undefined ? {} : { features }) }

    render(<LoansScreen />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    expect(screen.queryByRole('link', { name: 'Гостьові позики' })).not.toBeInTheDocument()
  })
})

describe('LoansScreen: розділ «Позичання» у «Моїй бібліотеці»', () => {
  const sectionNav = () => screen.getByRole('navigation', { name: 'Розділи бібліотеки' })

  it.each(['', 'tab=history'])(
    '?%s: під одним заголовком «Моя бібліотека» й навігацією, де поточний — «Позичання»',
    async (query) => {
      mockParameters = new URLSearchParams(query)
      apiRequest.mockResolvedValue({ loans: [], borrowed: [], lent: [] })

      render(<LoansScreen />)
      await screen.findByText(/Вашими книжками поки ніхто не цікавився|Ви поки нічого не брали/)

      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
        'Моя бібліотека',
      ])
      expect(screen.getAllByRole('main')).toHaveLength(1)
      expect(
        within(sectionNav())
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Книжки', 'Позичання', 'Вішлист'])
      expect(within(sectionNav()).getByRole('link', { name: 'Позичання' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      // Only the loans' own tabs here; the shelf tabs belong to «Книжки».
      expect(
        within(loansTablist())
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Мої книжки', 'Я позичаю', 'Історія'])
    },
  )

  it('пряме посилання ?loanId=…&role=… і далі відкриває одне позичання в тій самій рамці', async () => {
    mockParameters = new URLSearchParams('loanId=loan-7&role=borrower')
    apiRequest.mockRejectedValue(new Error('Не знайдено'))

    render(<LoansScreen />)

    expect(
      await screen.findByText('Можливо, це позичання вам не належить або його вже немає.'),
    ).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans/loan-7'])
    expect(within(sectionNav()).getByRole('link', { name: 'Позичання' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('?loanId= важливіший за tab=history: відкривається позичання, а не історія', async () => {
    mockParameters = new URLSearchParams('tab=history&loanId=loan-7')
    apiRequest.mockResolvedValue({ loan: BORROWED_LOAN })

    render(<LoansScreen />)

    expect(await screen.findByRole('link', { name: 'Книга на руках' })).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans/loan-7'])
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('«Показати всі» веде на бік, який дав сервер, а не на ?role= з адреси', async () => {
    mockParameters = new URLSearchParams('loanId=loan-7&role=owner')
    apiRequest.mockResolvedValue({ loan: BORROWED_LOAN })

    render(<LoansScreen />)

    expect(await screen.findByRole('link', { name: 'Показати всі' })).toHaveAttribute(
      'href',
      '/loans?role=borrower',
    )
  })

  it('дії над позичанням лишаються: позичальник бачить «Чекаємо…», власник — повернення й втрату', async () => {
    mockParameters = new URLSearchParams('loanId=loan-7')
    apiRequest.mockResolvedValue({ loan: BORROWED_LOAN })

    const { unmount } = render(<LoansScreen />)

    expect(await screen.findByText('Чекаємо, поки власник підтвердить повернення.')).toBeVisible()
    unmount()

    mockSession = { ...SIGNED_IN, user: { ...SIGNED_IN.user, id: 'user-marta' } }
    render(<LoansScreen />)

    await screen.findByRole('link', { name: 'Книга на руках' })
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['Книжку повернуто', 'Позначити втраченою']),
    )
  })
})
