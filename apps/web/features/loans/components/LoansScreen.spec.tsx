/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render as renderInDom, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import type { Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { SessionState } from '@/app/lib/use-session'
import { ToastProvider } from '@/components/ui/toast'
import { watchHistory } from '@/features/library/own-library/own-library.test-helpers'
import { initialDueDate } from '../model/approve-due-date'
import { shortDay } from '../model/loan-term'
import { loanOf } from '../loans.test-helpers'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: jest.requireActual<
    typeof import('@/features/library/own-library/own-library.test-helpers')
  >('@/features/library/own-library/own-library.test-helpers').useAddressSearchParams,
}))

const SIGNED_IN: Extract<SessionState, { status: 'authenticated' }> = {
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

let mockSession: SessionState = SIGNED_IN

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

/** The app's root layout mounts the toasts above every page; one loan's page reports with them. */
const render = (ui: ReactElement) => renderInDom(ui, { wrapper: ToastProvider })

const requestedPaths = () => apiRequest.mock.calls.map(([path]) => path as string)

/** Two of my books at Олесь, two of Марта's at me, and one loan already over. */
const LOANS: Loan[] = [
  loanOf({ id: '1984', side: 'lent', title: '1984', authors: ['Джордж Орвелл'] }),
  loanOf({
    id: 'dune',
    side: 'lent',
    status: 'REQUESTED',
    title: 'Дюна',
    authors: ['Френк Герберт'],
  }),
  loanOf({ id: 'farm', side: 'borrowed', status: 'APPROVED', title: 'Колгосп тварин' }),
  loanOf({
    id: 'late',
    side: 'borrowed',
    title: 'Мʼята',
    isOverdue: true,
    dueAt: '2026-10-20',
  }),
  loanOf({ id: 'old', side: 'borrowed', status: 'RETURNED', title: 'Атомні звички' }),
]

let unwatchHistory: () => void = () => undefined

function openAt(search = ''): void {
  window.history.replaceState(null, '', `/loans${search}`)
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue({ loans: LOANS })
  mockReplace.mockReset()
  mockPush.mockReset()
  mockSession = SIGNED_IN
  unwatchHistory = watchHistory()
  openAt()
})

afterEach(() => {
  unwatchHistory()
})

const loansTablist = () => screen.getByRole('tablist', { name: 'Вкладки позичань' })
const tab = (name: RegExp) => within(loansTablist()).getByRole('tab', { name })
const ALL = /^Усі/
const BORROWER = /^Я позичаю/
const OWNER = /^У мене позичають/
const HISTORY = /^Історія/

/** The rows' titles, in order: each row is one link whose name starts with its title. */
const rowTitles = async () =>
  (await within(screen.getByRole('tabpanel')).findAllByRole('listitem')).map(
    (item) => within(item).getByRole('link').getAttribute('aria-label')?.split(/[,.]/)[0],
  )
const rowOf = (title: string) => screen.findByRole('link', { name: new RegExp(`^${title}[,.]`) })
const search = () => screen.getByRole('searchbox', { name: 'Пошук позик' })

describe('LoansScreen: вкладки «Усі» / «Я позичаю» / «У мене позичають» / «Історія» (BS-153)', () => {
  it('без параметрів відкрито «Усі»: відкриті позики обох боків, один запит GET /loans', async () => {
    render(<LoansScreen />)

    expect(await rowTitles()).toEqual(['1984', 'Дюна', 'Колгосп тварин', 'Мʼята'])
    expect(tab(ALL)).toHaveAttribute('aria-selected', 'true')
    expect(
      within(loansTablist())
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Усі4', 'Я позичаю2', 'У мене позичають2', 'Історія'])
    expect(screen.getByText('4 позики')).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans'])
  })

  it.each([
    ['?role=borrower', BORROWER, ['Колгосп тварин', 'Мʼята']],
    ['?role=owner', OWNER, ['1984', 'Дюна']],
    ['?role=nobody', ALL, ['1984', 'Дюна', 'Колгосп тварин', 'Мʼята']],
  ])('%s відкриває свою вкладку', async (query, name, titles) => {
    openAt(query)

    render(<LoansScreen />)

    expect(await rowTitles()).toEqual(titles)
    expect(tab(name)).toHaveAttribute('aria-selected', 'true')
    expect(requestedPaths()).toEqual(['/loans'])
  })

  it('перемикання між поточними вкладками нічого не читає знову й міняє лише адресу', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await rowTitles()

    await user.click(tab(BORROWER))

    expect(await rowTitles()).toEqual(['Колгосп тварин', 'Мʼята'])
    expect(window.location.search).toBe('?role=borrower')

    await user.click(tab(ALL))

    expect(await rowTitles()).toHaveLength(4)
    expect(window.location.search).toBe('')
    expect(requestedPaths()).toEqual(['/loans'])
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('«Історія» читає лише /me/history, тримає пошук і зберігає ?tab=history', async () => {
    const user = userEvent.setup()

    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(path === '/me/history' ? { borrowed: [], lent: [] } : { loans: LOANS }),
    )
    openAt('?role=owner&q=%D0%B4%D1%8E')

    render(<LoansScreen />)
    await rowTitles()

    await user.click(tab(HISTORY))

    expect(await screen.findByText('Історія поки порожня')).toBeVisible()
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('history')
    expect(search()).toHaveValue('дю')
    // While «Історія» is open the current list is not read, so the tabs carry no counts.
    expect(tab(ALL)).toHaveTextContent(/^Усі$/)
    expect(requestedPaths()).toEqual(['/loans', '/me/history'])
  })

  it('стрілки й Enter перемикають вкладки; після переходу в «Історію» фокус лишається на вкладці', async () => {
    const user = userEvent.setup()

    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(path === '/me/history' ? { borrowed: [], lent: [] } : { loans: LOANS }),
    )

    render(<LoansScreen />)
    await rowTitles()

    tab(ALL).focus()
    await user.keyboard('{ArrowRight}{Enter}')

    expect(tab(BORROWER)).toHaveAttribute('aria-selected', 'true')
    expect(tab(BORROWER)).toHaveFocus()

    await user.keyboard('{End}{Enter}')

    expect(await screen.findByText('Історія поки порожня')).toBeVisible()
    expect(tab(HISTORY)).toHaveAttribute('aria-selected', 'true')
    expect(tab(HISTORY)).toHaveFocus()
  })

  it('поки список вантажиться — заглушки рядків і без лічильників', () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    render(<LoansScreen />)

    expect(
      within(screen.getByRole('tabpanel')).getByText('Завантажуємо позики…'),
    ).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true')
    expect(tab(ALL)).toHaveTextContent(/^Усі$/)
  })

  it('помилка — повідомлення з повторною спробою, яку запускає людина', async () => {
    const user = userEvent.setup()

    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )

    render(<LoansScreen />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити позики.')
    expect(screen.queryByText('Тут поки немає позик')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await rowTitles()).toHaveLength(4)
    expect(requestedPaths()).toEqual(['/loans', '/loans'])
  })
})

describe('LoansScreen: рядок позики', () => {
  it('увесь рядок — одне посилання на деталі, без вкладених кнопок і посилань', async () => {
    render(<LoansScreen />)

    const row = await rowOf('Колгосп тварин')

    expect(row).toHaveAttribute('href', '/loans?tab=all&loanId=farm')
    expect(row).toHaveAccessibleName(
      /Марта Ковалів, я позичаю\. Статус: Домовлено, ще не передано\./,
    )
    expect(row).toHaveAccessibleName(/Переглянути позику$/)
    expect(row).toHaveTextContent('Переглянути')
    expect(within(row).queryAllByRole('link')).toHaveLength(0)
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
  })

  it('підказка статусу — опис рядка; Escape ховає її, перехід фокуса повертає', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)

    const row = await rowOf('Колгосп тварин')
    const list = row.closest('ul')

    expect(row).toHaveAccessibleDescription(
      'Власник погодив запит. Позичальник підтверджує, коли отримає книжку.',
    )
    expect(within(row).getByRole('tooltip', { hidden: true })).toBeInTheDocument()

    row.focus()
    await user.keyboard('{Escape}')
    expect(list).toHaveAttribute('data-tips-hidden')

    await user.tab()
    expect(list).not.toHaveAttribute('data-tips-hidden')
  })

  it('прострочена позика — «Прострочено» за isOverdue з сервера, з датою, до якої мала повернутись', async () => {
    render(<LoansScreen />)

    const row = await rowOf('Мʼята')

    expect(row).toHaveAccessibleName(/Статус: Прострочено\. Мало повернутись/)
    expect(within(row).getByText('Прострочено')).toHaveClass('loan-badge--over')
  })
})

describe('LoansScreen: пошук і статус', () => {
  it('пошук за назвою, автором та іменем іншої сторони пише ?q= і рахує знайдене', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await rowTitles()

    await user.type(search(), 'орвелл')

    expect(await rowTitles()).toEqual(['1984'])
    expect(screen.getByText('Знайдено: 1 позика')).toBeVisible()
    expect(new URLSearchParams(window.location.search).get('q')).toBe('орвелл')
    // The row keeps the list's address beside its loan, so the loan's page can return to this search.
    expect(await rowOf('1984')).toHaveAttribute(
      'href',
      `/loans?q=${encodeURIComponent('орвелл')}&tab=all&loanId=1984`,
    )

    await user.clear(search())
    await user.type(search(), 'марта')

    expect(await rowTitles()).toEqual(['Колгосп тварин', 'Мʼята'])
  })

  it('«Очистити пошук» прибирає запит і повертає фокус у поле', async () => {
    const user = userEvent.setup()

    openAt('?q=%D0%B4%D1%8E%D0%BD%D0%B0')
    render(<LoansScreen />)

    expect(await rowTitles()).toEqual(['Дюна'])

    await user.click(screen.getByRole('button', { name: 'Очистити пошук' }))

    expect(search()).toHaveValue('')
    expect(search()).toHaveFocus()
    expect(await rowTitles()).toHaveLength(4)
    expect(window.location.search).toBe('')
  })

  it('фільтр статусу пропонує лише поточні статуси і пише ?status=', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await rowTitles()

    await user.click(screen.getByRole('combobox', { name: 'Статус' }))

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Усі статуси',
      'Чекає на відповідь',
      'Домовлено, ще не передано',
      'На руках',
      'Очікує підтвердження',
      'Прострочено',
    ])

    await user.click(screen.getByRole('option', { name: 'Прострочено' }))

    expect(await rowTitles()).toEqual(['Мʼята'])
    expect(new URLSearchParams(window.location.search).get('status')).toBe('OVERDUE')
  })

  it('«Нічого не знайдено» скидає пошук і статус, а вкладка лишається', async () => {
    const user = userEvent.setup()

    openAt('?role=owner&status=OVERDUE&q=x')
    render(<LoansScreen />)

    expect(await screen.findByRole('heading', { name: 'Нічого не знайдено' })).toBeVisible()
    expect(screen.getByText('Знайдено: 0 позик')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Скинути пошук і фільтри' }))

    expect(await rowTitles()).toEqual(['1984', 'Дюна'])
    expect(window.location.search).toBe('?role=owner')
    expect(tab(OWNER)).toHaveAttribute('aria-selected', 'true')
  })

  it('статус, якого вкладка не показує, з адреси не застосовується', async () => {
    openAt('?status=RETURNED')

    render(<LoansScreen />)

    expect(await rowTitles()).toHaveLength(4)
    expect(screen.getByRole('combobox', { name: 'Статус' })).toHaveTextContent('Усі статуси')
  })
})

describe('LoansScreen: порожні стани й «Нова позика»', () => {
  it('жодної відкритої позики — порожній стан з «Новою позикою» та каталогом', async () => {
    apiRequest.mockResolvedValue({ loans: [LOANS[4]] })

    render(<LoansScreen />)

    expect(await screen.findByRole('heading', { name: 'Тут поки немає позик' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Перейти до каталогу' })).toHaveAttribute(
      'href',
      '/catalog',
    )
    expect(screen.getAllByRole('button', { name: 'Нова позика' })).toHaveLength(2)
  })

  it('порожній лише цей бік — компактний стан цього боку', async () => {
    apiRequest.mockResolvedValue({ loans: LOANS.slice(0, 2) })
    openAt('?role=borrower')

    render(<LoansScreen />)

    expect(
      await screen.findByRole('heading', { name: 'Ви зараз нічого не позичаєте' }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Відкрити каталог' })).toHaveAttribute(
      'href',
      '/catalog',
    )
  })

  it('«Нова позика» веде лише в наявні сценарії: позичити свою книжку або попросити в друга', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await rowTitles()

    await user.click(screen.getByRole('button', { name: 'Нова позика' }))

    const items = await screen.findAllByRole('menuitem')

    expect(items.map((item) => [item.textContent, item.getAttribute('href')])).toEqual([
      ['Позичити свою книжкуОберіть примірник у «Книжках»', '/library'],
      ['Попросити книжку в другаЗнайдіть її в каталозі', '/catalog'],
    ])
    expect(requestedPaths()).toEqual(['/loans'])
  })
})

describe('LoansScreen: вхід у «Гостьові позики» (BS-104)', () => {
  it('за ввімкненого guestLoans посилання стоїть над вкладками й веде на /loans/guest', async () => {
    mockSession = { ...SIGNED_IN, features: { guestLoans: true } }

    render(<LoansScreen />)
    await rowTitles()

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
    await rowTitles()

    expect(screen.queryByRole('link', { name: 'Гостьові позики' })).not.toBeInTheDocument()
  })
})

describe('LoansScreen: розділ «Позичання» у «Моїй бібліотеці»', () => {
  const sectionNav = () => screen.getByRole('navigation', { name: 'Розділи бібліотеки' })

  it.each(['', '?tab=history'])(
    '%s: під одним заголовком «Моя бібліотека» й навігацією, де поточний — «Позичання»',
    async (query) => {
      openAt(query)
      apiRequest.mockResolvedValue({ loans: [], borrowed: [], lent: [] })

      render(<LoansScreen />)
      await screen.findByRole('heading', { name: /Тут поки немає позик|Історія поки порожня/ })

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
      expect(screen.getAllByRole('tablist')).toHaveLength(1)
    },
  )
})

describe('LoansScreen: одна позика за ?loanId= (дії — у деталях)', () => {
  const sectionNav = () => screen.getByRole('navigation', { name: 'Розділи бібліотеки' })
  const BORROWED_LOAN = loanOf({ id: 'loan-7', side: 'borrowed', title: 'Книга на руках' })
  /** «← Позичання» once the loan is in: until then the side is unknown and there is no link. */
  const backLink = async () => {
    await screen.findByRole('heading', { level: 3 })

    return within(screen.getByRole('navigation', { name: 'Шлях' })).getByRole('link', {
      name: 'Позичання',
    })
  }

  it('пряме посилання ?loanId=…&role=… відкриває одне позичання в тій самій рамці', async () => {
    openAt('?loanId=loan-7&role=borrower')
    // §8: someone else's loan is a 404 — the page says so only from the status (BS-153).
    apiRequest.mockRejectedValue(
      new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Не знайдено' }),
    )

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
    openAt('?tab=history&loanId=loan-7')
    apiRequest.mockResolvedValue({ loan: BORROWED_LOAN })

    render(<LoansScreen />)

    expect(await screen.findByRole('link', { name: 'Книга на руках' })).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans/loan-7'])
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('«← Позичання» веде на бік, який дав сервер, а не на ?role= з адреси', async () => {
    openAt('?loanId=loan-7&role=owner')
    apiRequest.mockResolvedValue({ loan: BORROWED_LOAN })

    render(<LoansScreen />)

    expect(await backLink()).toHaveAttribute('href', '/loans?role=borrower')
  })

  it('рядок списку відкриває деталі, де лишаються дії обох сторін', async () => {
    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/loans/loan-7' ? { loan: BORROWED_LOAN } : { loans: [BORROWED_LOAN] },
      ),
    )

    const { unmount } = render(<LoansScreen />)
    const row = await rowOf('Книга на руках')

    // Next follows the link; here the address is set by hand to the row's own href.
    openAt(new URL(row.getAttribute('href') ?? '', 'http://localhost').search)

    expect(await screen.findByRole('heading', { name: 'Книжка у вас' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Книжку повернуто' })).not.toBeInTheDocument()
    unmount()

    mockSession = { ...SIGNED_IN, user: { ...SIGNED_IN.user, id: 'user-marta' } }
    render(<LoansScreen />)

    await screen.findByRole('link', { name: 'Книга на руках' })
    expect(screen.getByRole('button', { name: 'Книжку повернуто' })).toBeEnabled()
    // BS-153: the loss is the rarer action — behind «⋯», still confirmed.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Інші дії з позикою' }))
    expect(await screen.findByRole('menuitem', { name: 'Позначити втраченою' })).toBeVisible()
  })
})

describe('LoansScreen: термін за замовчуванням у погодженні (BS-148)', () => {
  const REQUESTED_LOAN = loanOf({
    id: 'loan-7',
    side: 'borrowed',
    status: 'REQUESTED',
    respondedAt: null,
    handedAt: null,
    copy: { id: 'copy-loan-7', status: 'AVAILABLE', condition: 'GOOD', isArchived: false },
  })

  function openAsOwner(loan: Loan, defaultLoanTermDays: 14 | 21 | 30 | null): void {
    openAt(`?loanId=${loan.id}`)
    mockSession = {
      ...SIGNED_IN,
      user: { ...SIGNED_IN.user, id: 'user-marta', defaultLoanTermDays },
    }
    apiRequest.mockResolvedValue({ loan })
    render(<LoansScreen />)
  }

  /** BS-153 design update: the chosen date is the summary beside the calendar, not a date field. */
  const chosenDate = async () =>
    (await screen.findByRole('group', { name: 'Повернути до' })).querySelector('.loan-term__due')
      ?.textContent

  it('без дати від позичальника підставляє сьогодні + термін власника й надсилає її з погодженням', async () => {
    const user = userEvent.setup()

    openAsOwner(REQUESTED_LOAN, 21)

    const expected = initialDueDate(null, 21, new Date())

    expect(await chosenDate()).toBe(shortDay(expected))

    await user.click(screen.getByRole('button', { name: `Погодити до ${shortDay(expected)}` }))

    expect(apiRequest).toHaveBeenCalledWith(`/loans/${REQUESTED_LOAN.id}`, {
      method: 'PATCH',
      body: { action: 'approve', dueAt: expected },
    })
  })

  it('дата, яку попросив позичальник, лишається', async () => {
    openAsOwner({ ...REQUESTED_LOAN, dueAt: '2026-12-01' }, 30)

    expect(await chosenDate()).toBe('01.12.26')
  })

  it('без терміну власника й дати в запиті — «Без дати», погодження без терміну', async () => {
    openAsOwner(REQUESTED_LOAN, null)

    expect(await chosenDate()).toBe('Без дати')
    expect(screen.getByRole('radio', { name: /^Без дати/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Погодити без терміну' })).toBeEnabled()
  })
})
