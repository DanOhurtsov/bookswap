/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { formatDate } from '@/app/lib/labels'
import type { SessionState } from '@/app/lib/use-session'
import { ToastProvider } from '@/components/ui/toast'
import { watchHistory } from '@/features/library/own-library/own-library.test-helpers'
import { loanOf } from '../loans.test-helpers'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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

/** My copy at Олесь (`lent`, I am the owner) or Марта's at me (`borrowed`). */
const LENT = loanOf({ id: 'loan-7', side: 'lent', title: 'Дюна', dueAt: '2026-11-16' })
const BORROWED = loanOf({ id: 'loan-7', side: 'borrowed', title: 'Дюна', dueAt: '2026-11-16' })

const patches = () =>
  apiRequest.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method)

let unwatchHistory: () => void = () => undefined

/** The loan as `GET /loans/:id` answers; a `PATCH` goes to `onPatch`, the default accepts it. */
function serve(loan: Loan, onPatch: () => Promise<unknown> = () => Promise.resolve({ loan })) {
  apiRequest.mockImplementation((_path: string, init?: { method?: string }) =>
    init?.method === 'PATCH' ? onPatch() : Promise.resolve({ loan }),
  )
}

let rerenderScreen: () => void = () => undefined

function openLoan(search: string, loan: Loan): void {
  window.history.replaceState(null, '', `/loans${search}`)
  serve(loan)
  // The app's root layout mounts the toasts above every page.
  const { rerender } = render(<LoansScreen />, { wrapper: ToastProvider })

  rerenderScreen = () => {
    rerender(<LoansScreen />)
  }
}

const panel = () => screen.getByRole('region', { name: panelTitle() })
const panelTitle = () => document.querySelector('.loan-panel__title')?.textContent ?? ''
const dialog = () => screen.getByRole('alertdialog')
/** The toasts on screen: the badge may say the same words, a toast is told apart by its slot. */
const toasts = () =>
  Array.from(document.querySelectorAll('[data-slot="toast"]'), (toast) => toast.textContent)

/** The dialog's confirming button — after the one that only closes it. */
const confirmButton = () => within(dialog()).getAllByRole('button').at(-1) as HTMLElement

beforeAll(() => {
  // jsdom has no `PointerEvent`; Base UI builds one to activate a menu item from the keyboard.
  window.PointerEvent ??= class PointerEvent extends MouseEvent {} as typeof window.PointerEvent
  // jsdom has no modal dialogs: `showModal()` and `close()` only toggle `open`.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  apiRequest.mockReset()
  mockSession = SIGNED_IN
  unwatchHistory = watchHistory()
})

afterEach(() => {
  unwatchHistory()
})

describe('сторінка позики: інфопанель за роллю (BS-153)', () => {
  it('власник книжки на руках позначає повернення; «Позначити втраченою» — у «⋯»', async () => {
    openLoan('?loanId=loan-7', LENT)

    expect(await screen.findByRole('heading', { name: 'Книжка в позичальника' })).toBeVisible()
    expect(within(panel()).getByText(/до 16\.11\.2026|до 16 листопада/)).toBeVisible()
    expect(
      within(panel())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['', 'Книжку повернуто'])
    expect(within(panel()).getByRole('button', { name: 'Інші дії з позикою' })).toBeEnabled()
  })

  it('позичальник підтверджує отримання; власник такої дії не має', async () => {
    openLoan('?loanId=loan-7', { ...BORROWED, status: 'APPROVED', handedAt: null })

    expect(await screen.findByRole('button', { name: 'Я отримав книжку' })).toBeEnabled()
  })

  it('погоджену позику власник лише скасовує — «Я отримав книжку» в нього немає', async () => {
    openLoan('?loanId=loan-7', { ...LENT, status: 'APPROVED', handedAt: null })

    await screen.findByRole('heading', { name: 'Домовтеся про передачу' })
    expect(screen.queryByRole('button', { name: 'Я отримав книжку' })).not.toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Скасувати позику' })).toBeEnabled()
  })

  it('позичальник книжки на руках нічого не натискає: повернення позначає власник', async () => {
    openLoan('?loanId=loan-7', BORROWED)

    expect(await screen.findByRole('heading', { name: 'Книжка у вас' })).toBeVisible()
    expect(within(panel()).queryAllByRole('button')).toEqual([])
    expect(
      within(panel()).getByText(/Повернення позначає власник, коли отримає книжку\./),
    ).toBeVisible()
  })

  it('прострочення — з серверного isOverdue, не з дати', async () => {
    openLoan('?loanId=loan-7', { ...BORROWED, isOverdue: true, dueAt: '2026-10-20' })

    expect(await screen.findByRole('heading', { name: 'Час повернути книжку' })).toBeVisible()
    expect(screen.getByText('Строк повернення минув')).toBeVisible()
  })
})

describe('сторінка позики: дії, очікування й результат', () => {
  it('поки дія виконується, кнопка каже «Виконую…», усе вимкнено, повтор не шле запит', async () => {
    const user = userEvent.setup()
    let accept: (value: unknown) => void = () => undefined

    openLoan('?loanId=loan-7', LENT)
    serve(LENT, () => new Promise((resolve) => (accept = resolve)))

    await user.click(await screen.findByRole('button', { name: 'Книжку повернуто' }))

    const running = within(panel()).getByRole('button', { name: 'Виконую…' })

    expect(running).toBeDisabled()
    expect(running).toHaveAttribute('aria-busy', 'true')
    expect(within(panel()).getByRole('button', { name: 'Інші дії з позикою' })).toBeDisabled()
    await user.click(running)
    expect(patches()).toHaveLength(1)
    expect(toasts()).toEqual([])

    accept({})

    await waitFor(() => {
      expect(toasts()).toEqual(['Повернення позначено. Позику завершено'])
    })
    expect(apiRequest).toHaveBeenCalledWith('/loans/loan-7', {
      method: 'PATCH',
      body: { action: 'return' },
    })
  })

  it('дві кнопки діалогу скасування не мають спільного слова', async () => {
    const user = userEvent.setup()

    openLoan('?loanId=loan-7', { ...LENT, status: 'APPROVED', handedAt: null })
    await user.click(await screen.findByRole('button', { name: 'Скасувати позику' }))

    expect(within(dialog()).getByRole('heading', { name: 'Скасувати позику?' })).toBeVisible()
    expect(
      within(dialog())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Не скасовувати', 'Скасувати позику'])
    await user.click(within(dialog()).getByRole('button', { name: 'Не скасовувати' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(patches()).toHaveLength(0)
  })

  it('запит позичальник скасовує лише після підтвердження «Скасувати запит»', async () => {
    const user = userEvent.setup()
    const requested = {
      ...BORROWED,
      status: 'REQUESTED' as const,
      respondedAt: null,
      handedAt: null,
    }

    openLoan('?loanId=loan-7', requested)
    await user.click(await screen.findByRole('button', { name: 'Скасувати запит' }))

    expect(patches()).toHaveLength(0)
    expect(
      within(dialog())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Не скасовувати', 'Скасувати запит'])
    await user.click(confirmButton())
    expect(apiRequest).toHaveBeenCalledWith('/loans/loan-7', {
      method: 'PATCH',
      body: { action: 'cancel' },
    })
  })

  it('невдача: помилка в діалозі, фокус у ньому; повтор прибирає її, успіх закриває діалог і дає toast', async () => {
    const user = userEvent.setup()
    const approved = { ...LENT, status: 'APPROVED' as const, handedAt: null }
    const conflict = new ApiRequestError(409, {
      code: 'LOAN_INVALID_TRANSITION',
      message: 'Позику вже змінено',
    })

    openLoan('?loanId=loan-7', approved)
    serve(approved, () => Promise.reject(conflict))

    await user.click(await screen.findByRole('button', { name: 'Скасувати позику' }))
    await user.click(confirmButton())

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Позику вже змінено')
    expect(dialog()).toBeVisible()
    expect(dialog()).toContainElement(document.activeElement as HTMLElement)
    expect(toasts()).toEqual([])

    let accept: (value: unknown) => void = () => undefined

    serve({ ...approved, status: 'CANCELLED' }, () => new Promise((resolve) => (accept = resolve)))
    await user.click(confirmButton())

    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument()
    expect(confirmButton()).toHaveTextContent('Виконую…')
    expect(dialog()).toContainElement(document.activeElement as HTMLElement)

    accept({})

    await waitFor(() => {
      expect(toasts()).toEqual(['Скасовано'])
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('поки дія з діалогу виконується, ні клік, ні Enter, ні Space не повторюють її й не закривають діалог', async () => {
    const user = userEvent.setup()
    const approved = { ...LENT, status: 'APPROVED' as const, handedAt: null }
    let accept: (value: unknown) => void = () => undefined

    openLoan('?loanId=loan-7', approved)
    serve(approved, () => new Promise((resolve) => (accept = resolve)))

    await user.click(await screen.findByRole('button', { name: 'Скасувати позику' }))

    expect(dialog()).toHaveAccessibleName('Скасувати позику?')
    expect(dialog()).toHaveAccessibleDescription(/Домовленість скасується/)
    await user.click(within(dialog()).getByRole('button', { name: 'Скасувати позику' }))

    const running = within(dialog()).getByRole('button', { name: 'Виконую…' })
    const dismiss = within(dialog()).getByRole('button', { name: 'Не скасовувати' })

    expect(running).toHaveAttribute('aria-disabled', 'true')
    expect(dismiss).toHaveAttribute('aria-disabled', 'true')
    expect(running).toHaveFocus()

    await user.click(running)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    dismiss.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    await user.click(dismiss)

    expect(patches()).toHaveLength(1)
    expect(dialog()).toBeVisible()

    accept({})

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(patches()).toHaveLength(1)
  })

  it('помилка після закриття діалогу — в інфопанелі (role="alert"), до наступної успішної дії', async () => {
    const user = userEvent.setup()

    openLoan('?loanId=loan-7', LENT)
    serve(LENT, () =>
      Promise.reject(new ApiRequestError(409, { code: 'CONFLICT', message: 'Не вийшло' })),
    )

    await user.click(await screen.findByRole('button', { name: 'Інші дії з позикою' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Позначити втраченою' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Позначити втраченою' }))
    await within(dialog()).findByRole('alert')
    await user.click(within(dialog()).getByRole('button', { name: 'Назад' }))

    expect(within(panel()).getByRole('alert')).toHaveTextContent('Не вийшло')

    serve({ ...LENT, status: 'RETURNED', returnedAt: '2026-11-06T09:00:00.000Z' })
    await user.click(within(panel()).getByRole('button', { name: 'Книжку повернуто' }))

    await screen.findByRole('heading', { name: 'Позику завершено' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('«Позначити втраченою» з «⋯» з клавіатури; після закриття фокус — знову на «⋯»', async () => {
    const user = userEvent.setup()

    openLoan('?loanId=loan-7', LENT)

    const more = await screen.findByRole('button', { name: 'Інші дії з позикою' })

    more.focus()
    await user.keyboard('{Enter}')
    const item = await screen.findByRole('menuitem', { name: 'Позначити втраченою' })

    expect(item).toHaveAttribute('data-variant', 'destructive')
    await user.keyboard('{Enter}')

    expect(within(dialog()).getByRole('heading', { name: 'Позначити втраченою?' })).toBeVisible()
    expect(dialog()).toHaveAccessibleDescription(/Примірник позначиться як недоступний/)

    within(dialog()).getByRole('button', { name: 'Назад' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
    expect(patches()).toHaveLength(0)
  })

  it('після успіху сторінка не перемальовується з нуля: «⋯» зникла — фокус на заголовку панелі', async () => {
    const user = userEvent.setup()

    openLoan('?loanId=loan-7', LENT)
    await user.click(await screen.findByRole('button', { name: 'Інші дії з позикою' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Позначити втраченою' }))
    serve({ ...LENT, status: 'LOST' })
    await user.click(confirmButton())

    const title = await screen.findByRole('heading', {
      level: 4,
      name: 'Книжку позначено втраченою',
    })

    await waitFor(() => {
      expect(title).toHaveFocus()
    })
  })

  it.each([
    ['власник', LENT, 'Відкликати запис'],
    ['позичальник', BORROWED, 'Відхилити запис'],
  ])(
    'записана позика: %s — «%s» лише через діалог з червоною кнопкою',
    async (_who, loan, label) => {
      const user = userEvent.setup()

      openLoan('?loanId=loan-7', {
        ...loan,
        origin: 'RECORDED_EXISTING',
        status: 'PENDING_CONFIRMATION',
      })
      await user.click(await within(await findPanel()).findByRole('button', { name: label }))

      expect(patches()).toHaveLength(0)
      expect(confirmButton()).toHaveTextContent(label)
      expect(confirmButton()).toHaveClass('loan-action--danger')
    },
  )
})

/** `GET /loans/:id` fails with this (an `ApiRequestError` of that status, or no response at all). */
const failure = (status: number | 'network') =>
  status === 'network'
    ? new TypeError('Failed to fetch')
    : new ApiRequestError(status, {
        code: status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
        message: `Request failed with status ${String(status)}`,
      })

function openFailing(status: number | 'network'): void {
  window.history.replaceState(null, '', '/loans?role=owner&q=x&loanId=loan-7')
  apiRequest.mockRejectedValueOnce(failure(status))
  render(<LoansScreen />, { wrapper: ToastProvider })
}

describe('сторінка позики: помилка завантаження за статусом', () => {
  it.each([403, 404])(
    '%i — нейтральне «Позику не знайдено», без повтору й без слів сервера',
    async (status) => {
      openFailing(status)

      const notice = await screen.findByRole('alert')

      expect(within(notice).getByText('Позику не знайдено')).toBeVisible()
      expect(
        within(notice).getByText('Можливо, це позичання вам не належить або його вже немає.'),
      ).toBeVisible()
      expect(within(notice).queryByRole('button')).not.toBeInTheDocument()
      expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument()
      // No loan, so no side the server confirmed: `role=` is not trusted; the search stays.
      expect(
        within(screen.getByRole('navigation', { name: 'Шлях' })).getByRole('link', {
          name: 'Позичання',
        }),
      ).toHaveAttribute('href', '/loans?q=x')
    },
  )

  it.each([500, 503, 'network'] as const)(
    '%s — «Не вдалося завантажити позику» з повтором; сирих слів сервера немає',
    async (status) => {
      openFailing(status)

      const notice = await screen.findByRole('alert')

      expect(within(notice).getByText('Не вдалося завантажити позику')).toBeVisible()
      expect(within(notice).getByRole('button', { name: 'Спробувати ще раз' })).toBeEnabled()
      expect(screen.queryByText(/Request failed|Failed to fetch|звʼязатися з API/)).toBeNull()
      expect(screen.queryByText('Позику не знайдено')).not.toBeInTheDocument()
    },
  )

  it('401 — «Сесія завершилася» з входом, що поверне на цю позику', async () => {
    openFailing(401)

    const notice = await screen.findByRole('alert')

    expect(within(notice).getByText('Сесія завершилася')).toBeVisible()
    expect(within(notice).getByRole('link', { name: 'Увійти' })).toHaveAttribute(
      'href',
      `/login?returnTo=${encodeURIComponent('/loans?role=owner&q=x&loanId=loan-7')}`,
    )
    expect(within(notice).queryByRole('button')).not.toBeInTheDocument()
  })

  it('повтор показує роботу; ні клік, ні Enter, ні Space не шлють другий запит', async () => {
    const user = userEvent.setup()
    let answer: (value: unknown) => void = () => undefined

    openFailing(503)
    const retry = await screen.findByRole('button', { name: 'Спробувати ще раз' })

    apiRequest.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await user.click(retry)

    const running = screen.getByRole('button', { name: 'Завантажую…' })

    expect(running).toHaveAttribute('aria-disabled', 'true')
    expect(running).toHaveAttribute('aria-busy', 'true')
    expect(running).toHaveFocus()
    await user.click(running)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(apiRequest).toHaveBeenCalledTimes(2)

    answer({ loan: LENT })

    expect(await screen.findByRole('heading', { name: 'Книжка в позичальника' })).toBeVisible()
  })
})

describe('сторінка позики: що лишається на екрані між завантаженнями', () => {
  /** The loan is in, then an action goes through and the re-read answers `reread`. */
  async function rereadAfterAction(reread: unknown) {
    const user = userEvent.setup()

    openLoan('?loanId=loan-7', LENT)
    await screen.findByRole('heading', { name: 'Книжка в позичальника' })
    apiRequest.mockImplementation((_path: string, init?: { method?: string }) =>
      init?.method === 'PATCH' ? Promise.resolve({}) : Promise.reject(reread),
    )
    await user.click(screen.getByRole('button', { name: 'Книжку повернуто' }))
  }

  it('перечитування дало 404 — стара позика зникає, «Позику не знайдено»', async () => {
    await rereadAfterAction(failure(404))

    expect(await screen.findByText('Позику не знайдено')).toBeVisible()
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Книжку повернуто' })).not.toBeInTheDocument()
  })

  it('перечитування дало 403 — так само, без натяку, що позика є', async () => {
    await rereadAfterAction(failure(403))

    expect(await screen.findByText('Позику не знайдено')).toBeVisible()
    expect(screen.queryByText('Дюна')).not.toBeInTheDocument()
  })

  it.each([503, 'network'] as const)(
    'перечитування дало %s — позика лишається, над нею «Не вдалося оновити позику»',
    async (status) => {
      await rereadAfterAction(failure(status))

      expect(await screen.findByText('Не вдалося оновити позику')).toBeVisible()
      expect(screen.getByRole('heading', { level: 3, name: 'Дюна' })).toBeVisible()
    },
  )

  it('інший акаунт — новий запит, а позика попереднього не показується ні на мить', async () => {
    openLoan('?loanId=loan-7', LENT)
    await screen.findByRole('heading', { level: 3, name: 'Дюна' })

    apiRequest.mockImplementation(() => new Promise(() => undefined))
    mockSession = { ...SIGNED_IN, user: { ...SIGNED_IN.user, id: 'user-oles' } }
    act(() => {
      rerenderScreen()
    })

    expect(screen.queryByText('Дюна')).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenLastCalledWith('/loans/loan-7', expect.anything())
  })

  it('вихід — жодних даних позики на екрані', async () => {
    openLoan('?loanId=loan-7', LENT)
    await screen.findByRole('heading', { level: 3, name: 'Дюна' })

    mockSession = { status: 'guest' }
    act(() => {
      rerenderScreen()
    })

    expect(screen.queryByText('Дюна')).not.toBeInTheDocument()
  })

  it('інший loanId — скелет до відповіді, а не попередня позика', async () => {
    openLoan('?loanId=loan-7', LENT)
    await screen.findByRole('heading', { level: 3, name: 'Дюна' })

    apiRequest.mockImplementation(() => new Promise(() => undefined))
    act(() => {
      window.history.pushState(null, '', '/loans?loanId=loan-8')
    })

    await waitFor(() => {
      expect(screen.queryByText('Дюна')).not.toBeInTheDocument()
    })
    expect(apiRequest).toHaveBeenLastCalledWith('/loans/loan-8', expect.anything())
  })
})

describe('сторінка позики: дорога назад і факти', () => {
  it('зі списку «У мене позичають» з пошуком «← Позичання» повертає туди ж', async () => {
    openLoan('?role=owner&q=%D0%B4%D1%8E&status=HANDED_OVER&loanId=loan-7', LENT)

    expect(await backLink()).toHaveAttribute(
      'href',
      '/loans?role=owner&q=%D0%B4%D1%8E&status=HANDED_OVER',
    )
  })

  it('loanId важливіший за tab=history; назад — в історію з її пошуком', async () => {
    const returned = { ...LENT, status: 'RETURNED' as const, returnedAt: '2026-10-25T09:00:00Z' }

    openLoan('?tab=history&q=x&loanId=loan-7', returned)

    expect(await backLink()).toHaveAttribute('href', '/loans?tab=history&q=x')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('пряме посилання: назад — у список, де ця позика є (відкрита — свій бік, закрита — історія)', async () => {
    openLoan('?loanId=loan-7', BORROWED)
    expect(await backLink()).toHaveAttribute('href', '/loans?role=borrower')
  })

  it('пряме посилання на завершену позику веде в історію', async () => {
    openLoan('?loanId=loan-7', { ...LENT, status: 'RETURNED', returnedAt: '2026-10-25T09:00:00Z' })
    expect(await backLink()).toHaveAttribute('href', '/loans?tab=history')
  })

  it('назва книжки й друга сторона — посилання; історія — лише дати з API', async () => {
    openLoan('?loanId=loan-7', {
      ...BORROWED,
      status: 'REQUESTED',
      respondedAt: null,
      handedAt: null,
      message: 'Дуже хочу перечитати',
    })

    expect(await screen.findByRole('link', { name: 'Дюна' })).toHaveAttribute(
      'href',
      '/works/work-loan-7',
    )
    expect(screen.getByRole('link', { name: /Марта Ковалів/ })).toHaveAttribute('href', '/u/marta')

    const history = screen.getByRole('region', { name: 'Історія позики' })
    const steps = within(history).getAllByRole('listitem')

    expect(steps.map((step) => step.textContent)).toEqual([
      `Запит надіслано · ${formatDate('2026-10-01T09:00:00.000Z')}`,
      'Далі: Відповідь власника',
    ])
    expect(within(history).getByText(formatDate('2026-10-01T09:00:00.000Z'))).toHaveAttribute(
      'datetime',
      '2026-10-01T09:00:00.000Z',
    )
    expect(screen.getByText('«Дуже хочу перечитати»')).toBeVisible()
  })
})

/** The panel once the loan is in. */
async function findPanel() {
  await screen.findByRole('heading', { level: 3 })

  return panel()
}

/** «← Позичання» once the loan is in: until then the side is unknown and there is no link. */
async function backLink() {
  await screen.findByRole('heading', { level: 3 })

  return within(screen.getByRole('navigation', { name: 'Шлях' })).getByRole('link', {
    name: 'Позичання',
  })
}
