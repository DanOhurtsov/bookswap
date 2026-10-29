/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Me, ProfileSummary, UpdateProfileRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { ToastProvider } from '@/components/ui/toast'
import { chooseOption } from '@/components/Form/test-choose-option'
import { INVITE_DONE_MS } from '../model/use-invite-link'
import { ProfileScreen } from './ProfileScreen'

/**
 * BS-148, sub-stage F: the profile page by role, label and text. `apiRequest` is a small in-memory
 * server: the session reads what the last successful PATCH stored.
 */

// jsdom has no `PointerEvent`; Base UI builds one when a switch is clicked (as in `SelectField.spec`).
window.PointerEvent ??= class PointerEvent extends MouseEvent {} as typeof window.PointerEvent

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

interface RequestOptions {
  method?: string
  body?: unknown
}

const saved: Me = {
  id: 'user-1',
  email: 'marta@example.com',
  emailVerified: true,
  displayName: 'Марта',
  handle: 'marta',
  city: 'Вроцлав',
  avatarUrl: null,
  bio: 'Читаю фантастику',
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  friendsOfFriendsAccess: false,
  loanRequestsPaused: false,
  defaultLoanTermDays: null,
  ownerDueReminders: true,
  createdAt: '2026-09-05T08:00:00.000Z',
}

const ANDRII = { id: 'user-2', displayName: 'Андрій', handle: 'andrii', avatarUrl: null }

const fullSummary: ProfileSummary = {
  stats: { copies: 86, friends: 23, lentLoans: 41, wishlist: 12 },
  reliability: { returnedOnTime: 18, returnedWithDue: 19, averageLoanDays: 21, outNow: 2 },
  books: {
    items: [
      {
        copyId: 'copy-1',
        edition: {
          id: 'edition-1',
          workId: 'work-1',
          translationId: null,
          publisher: null,
          year: null,
          isbn13: null,
          pageCount: null,
          coverUrl: null,
          format: null,
          textKind: 'ORIGINAL',
          lang: 'uk',
          translator: null,
          revision: 1,
        },
        work: {
          id: 'work-1',
          title: 'Тигролови',
          origLang: 'uk',
          firstPubYear: 1944,
          description: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
        },
        authors: [
          { id: 'a-1', name: 'Іван Багряний', nameLatin: null, role: 'AUTHOR', position: 0 },
        ],
        place: {
          kind: 'LENT',
          holder: { kind: 'USER', user: ANDRII },
          dueAt: '2026-11-02',
          overdue: false,
        },
      },
    ],
    total: 86,
  },
  friends: { items: [ANDRII], total: 23 },
  activity: [
    {
      kind: 'LOAN',
      event: 'HANDED_OVER',
      at: '2026-10-19T10:00:00.000Z',
      loanId: 'loan-1',
      role: 'OWNER',
      counterpart: { kind: 'USER', user: ANDRII },
      work: { id: 'work-1', title: 'Тигролови' },
    },
  ],
}

const emptySummary: ProfileSummary = {
  stats: { copies: 0, friends: 0, lentLoans: 0, wishlist: 0 },
  reliability: { returnedOnTime: 0, returnedWithDue: 0, averageLoanDays: null, outNow: 0 },
  books: { items: [], total: 0 },
  friends: { items: [], total: 0 },
  activity: [],
}

let stored: Me
let summaryAnswer: () => Promise<ProfileSummary>
/** Replaces the default PATCH answer; the default stores the body like the API does. */
let patchAnswer: ((body: UpdateProfileRequest) => Promise<Me>) | undefined
let inviteAnswer: () => Promise<{ token?: string }>

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === '/auth/session') {
      return Promise.resolve({ user: stored, features: { guestLoans: false } })
    }
    if (path === '/me/profile-summary') return summaryAnswer()
    if (path === '/me' && options.method === 'PATCH') {
      const body = options.body as UpdateProfileRequest

      if (patchAnswer !== undefined) return patchAnswer(body)

      stored = { ...stored, ...body }

      return Promise.resolve(stored)
    }
    if (path === '/auth/email-verification' && options.method === 'POST') {
      return Promise.resolve({ accepted: true })
    }
    if (path === '/invitations' && options.method === 'POST') return inviteAnswer()

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function patches(): unknown[] {
  return apiRequest.mock.calls
    .filter(([path, options]) => path === '/me' && (options as RequestOptions).method === 'PATCH')
    .map(([, options]) => (options as RequestOptions).body)
}

function summaryReads(): number {
  return apiRequest.mock.calls.filter(([path]) => path === '/me/profile-summary').length
}

/** What the rest of the app sees: the session user, outside the profile screen. */
function SessionProbe() {
  const { state } = useSession()

  return (
    <output aria-label="Користувач сесії">
      {state.status === 'authenticated' ? JSON.stringify(state.user) : state.status}
    </output>
  )
}

function renderProfile() {
  return render(
    withQueryClient(
      <SessionProvider>
        {/* The app's layout mounts it above every page: the invitation tells its copy with a toast. */}
        <ToastProvider>
          <SessionProbe />
          <ProfileScreen />
        </ToastProvider>
      </SessionProvider>,
    ),
  )
}

function sessionUser(): Me {
  return JSON.parse(
    screen.getByRole('status', { name: 'Користувач сесії' }).textContent ?? '{}',
  ) as Me
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  stored = { ...saved }
  summaryAnswer = () => Promise.resolve(fullSummary)
  patchAnswer = undefined
  inviteAnswer = () => Promise.resolve({ token: 'invite-token' })
  serve()
})

describe('ProfileScreen: картка профілю', () => {
  it('імʼя, нік · місто, біо; «Редагувати профіль» веде на /profile/edit', async () => {
    renderProfile()

    const hero = await screen.findByRole('region', { name: 'Профіль' })

    expect(within(hero).getByRole('heading', { level: 1, name: 'Марта' })).toBeInTheDocument()
    expect(hero).toHaveTextContent('@marta · Вроцлав')
    expect(hero).not.toHaveTextContent('у BookSwap з')
    expect(hero).toHaveTextContent('Читаю фантастику')
    expect(within(hero).getByRole('link', { name: 'Редагувати профіль' })).toHaveAttribute(
      'href',
      '/profile/edit',
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('без біо — на його місці нічого', async () => {
    stored = { ...saved, bio: null }
    renderProfile()

    const hero = await screen.findByRole('region', { name: 'Профіль' })
    expect(hero).toHaveTextContent('@marta · Вроцлав')
    expect(hero).not.toHaveTextContent('Читаю фантастику')
    expect(hero).not.toHaveTextContent('Ще нічого не розповіли')
  })

  it('статистика зі зведення — з підписами за числом', async () => {
    renderProfile()

    const hero = await screen.findByRole('region', { name: 'Профіль' })

    await waitFor(() => {
      expect(within(hero).getByText('книжок у бібліотеці')).toBeInTheDocument()
    })
    for (const label of ['друзі', 'позика друзям', 'у вішлисті']) {
      expect(within(hero).getByText(label)).toBeInTheDocument()
    }
    expect(within(hero).getByText('86')).toBeInTheDocument()
  })
})

describe('ProfileScreen: зведення', () => {
  it('книжки з місцем, активність, надійність і друзі — з посиланнями', async () => {
    renderProfile()

    const book = await screen.findByRole('link', {
      name: 'Тигролови, Іван Багряний. У Андрій до 2 лист.',
    })

    expect(book).toHaveAttribute('href', '/library/copy-1')
    expect(screen.getByRole('link', { name: /Усі 86/ })).toHaveAttribute('href', '/library')

    expect(screen.getByRole('link', { name: /Книжка «Тигролови» тепер у Андрій/ })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-1',
    )
    expect(screen.getByRole('link', { name: /Історія позик/ })).toHaveAttribute(
      'href',
      '/loans?tab=history',
    )

    const trust = card('Надійність')

    expect(within(trust).getByText('18 з 19')).toBeInTheDocument()
    expect(
      within(trust).getByRole('img', { name: '18 з 19 позик повернуто вчасно' }),
    ).toBeInTheDocument()
    expect(trust).toHaveTextContent('Середній термін позики3 тижні')
    expect(trust).toHaveTextContent('Зараз у друзів2 книжки')

    const friends = card('Друзі')

    expect(within(friends).getByRole('link', { name: 'Андрій' })).toHaveAttribute(
      'href',
      '/u/andrii',
    )
    expect(within(friends).getByRole('link', { name: /Усі 23/ })).toHaveAttribute(
      'href',
      '/friends',
    )
  })

  it('порожній акаунт: порожні стани з дією, без «Усі»', async () => {
    summaryAnswer = () => Promise.resolve(emptySummary)
    renderProfile()

    expect(await screen.findByText('Полиця порожня')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Додати книжку' })).toHaveAttribute(
      'href',
      '/catalog/new',
    )
    expect(screen.getByText('Активності поки немає')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Перейти до каталогу' })).toHaveAttribute(
      'href',
      '/catalog',
    )
    expect(within(card('Друзі')).getByText('Ще немає друзів')).toBeInTheDocument()
    expect(within(card('Друзі')).getByRole('button', { name: 'Запросити друзів' })).toBeEnabled()
    expect(card('Надійність')).toHaveTextContent('Ще немає повернених позик із терміном.')
    expect(card('Надійність')).not.toHaveTextContent('Середній термін')
    expect(screen.queryByRole('link', { name: /^Усі/ })).not.toBeInTheDocument()
  })

  it('помилка зведення: повідомлення й «Спробувати ще», картка й налаштування лишаються', async () => {
    const user = userEvent.setup()

    summaryAnswer = () =>
      Promise.reject(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }))
    renderProfile()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не вдалося завантажити зведення профілю. Збій сервера',
    )
    expect(card('Профіль')).toBeInTheDocument()
    expect(card('Налаштування позичання')).toBeInTheDocument()

    summaryAnswer = () => Promise.resolve(fullSummary)
    await user.click(screen.getByRole('button', { name: 'Спробувати ще' }))

    expect(
      await screen.findByRole('link', { name: /^Тигролови, Іван Багряний/ }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(summaryReads()).toBe(2)
  })
})

describe('ProfileScreen: налаштування позичання', () => {
  it('перемикачі — рядки role=switch зі станом із профілю', async () => {
    stored = { ...saved, friendsOfFriendsAccess: true }
    renderProfile()

    const settings = await screen.findByRole('region', { name: 'Налаштування позичання' })

    expect(
      within(settings).getByRole('switch', { name: 'Нагадувати про повернення' }),
    ).toBeChecked()
    expect(
      within(settings).getByRole('switch', { name: 'Нагадувати про повернення' }),
    ).toHaveAccessibleDescription('За 3 дні до терміну повернення ваших книжок')
    expect(
      within(settings).getByRole('switch', { name: 'Бібліотека для друзів друзів' }),
    ).toBeChecked()
    expect(within(settings).getByRole('switch', { name: 'Пауза для запитів' })).not.toBeChecked()
  })

  it('зміна зберігається одразу: PATCH лише цього поля, нове значення в сесії', async () => {
    const user = userEvent.setup()

    renderProfile()

    await user.click(await screen.findByRole('switch', { name: 'Пауза для запитів' }))

    await waitFor(() => {
      expect(sessionUser().loanRequestsPaused).toBe(true)
    })
    expect(patches()).toEqual([{ loanRequestsPaused: true }])
    expect(screen.getByRole('switch', { name: 'Пауза для запитів' })).toBeChecked()
  })

  it('поки зберігається, нове значення вже видно, а перемикачі зачекають; відмова повертає старе', async () => {
    const user = userEvent.setup()
    let refuse: (error: unknown) => void = () => undefined

    patchAnswer = () =>
      new Promise((_, reject) => {
        refuse = reject
      })
    renderProfile()

    const reminders = await screen.findByRole('switch', { name: 'Нагадувати про повернення' })

    await user.click(reminders)

    expect(reminders).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Пауза для запитів' })).toBeDisabled()

    act(() => {
      refuse(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }))
    })

    await waitFor(() => {
      expect(reminders).toBeChecked()
    })
    expect(within(card('Налаштування позичання')).getByRole('alert')).toHaveTextContent(
      'Не вдалося зберегти налаштування. Збій сервера',
    )
    expect(within(card('Акаунт')).queryByRole('alert')).not.toBeInTheDocument()
    expect(sessionUser().ownerDueReminders).toBe(true)
  })

  it('термін: «Власна дата» для null; вибір терміну зберігає дні, «Власна дата» — null', async () => {
    const user = userEvent.setup()

    renderProfile()

    const term = await screen.findByRole('combobox', { name: 'Термін за замовчуванням' })

    expect(term).toHaveTextContent('Власна дата')

    await chooseOption(user, 'Термін за замовчуванням', '3 тижні')
    await waitFor(() => {
      expect(sessionUser().defaultLoanTermDays).toBe(21)
    })

    await chooseOption(user, 'Термін за замовчуванням', 'Власна дата')
    await waitFor(() => {
      expect(sessionUser().defaultLoanTermDays).toBeNull()
    })
    expect(patches()).toEqual([{ defaultLoanTermDays: 21 }, { defaultLoanTermDays: null }])
  })
})

describe('ProfileScreen: акаунт', () => {
  it('email, видимість бібліотеки й показ тримачів зберігаються одразу; посилання на сповіщення', async () => {
    const user = userEvent.setup()

    renderProfile()

    const account = await screen.findByRole('region', { name: 'Акаунт' })

    expect(account).toHaveTextContent('marta@example.com')
    expect(within(account).getByRole('link', { name: 'Налаштування сповіщень' })).toHaveAttribute(
      'href',
      '/notifications/settings',
    )

    await user.click(
      within(account).getByRole('switch', { name: 'Друзі бачитимуть, хто читає мої книжки' }),
    )
    await waitFor(() => {
      expect(sessionUser().showHolderNames).toBe(false)
    })

    await chooseOption(user, 'Видимість бібліотеки за замовчуванням', 'Приватна — тільки я')
    await waitFor(() => {
      expect(sessionUser().libraryVisibility).toBe('PRIVATE')
    })
    expect(patches()).toEqual([{ showHolderNames: false }, { libraryVisibility: 'PRIVATE' }])
  })

  it('непідтверджений email: лист можна надіслати ще раз', async () => {
    const user = userEvent.setup()

    stored = { ...saved, emailVerified: false }
    renderProfile()

    expect(await screen.findByText('Адресу ще не підтверджено.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Надіслати лист ще раз' }))

    expect(await screen.findByText('Лист надіслано — перевірте пошту.')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(
      '/auth/email-verification',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('підтверджений email не показує попередження', async () => {
    renderProfile()

    await screen.findByRole('region', { name: 'Акаунт' })

    expect(screen.queryByText('Адресу ще не підтверджено.')).not.toBeInTheDocument()
  })
})

describe('ProfileScreen: запросити друзів', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('створює посилання, копіює його й на 2,2 с каже «Посилання скопійовано»', async () => {
    jest.useFakeTimers({ advanceTimers: true })

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    renderProfile()

    const hero = await screen.findByRole('region', { name: 'Профіль' })

    await user.click(within(hero).getByRole('button', { name: 'Запросити друзів' }))

    // Disabled yet focusable: the tooltip and the name stay reachable while a repeat click does nothing.
    const done = await within(hero).findByRole('button', { name: 'Посилання скопійовано' })
    expect(done).toHaveAttribute('aria-disabled', 'true')
    // Said in a toast as well: a touch screen has no hover to show the tooltip.
    expect(await screen.findByText('Посилання скопійовано')).toBeInTheDocument()
    await user.click(done)
    expect(await navigator.clipboard.readText()).toBe(
      `${window.location.origin}/invite#invite-token`,
    )
    expect(apiRequest).toHaveBeenCalledWith(
      '/invitations',
      expect.objectContaining({ method: 'POST', body: { kind: 'LINK' } }),
    )
    expect(apiRequest.mock.calls.filter(([path]) => path === '/invitations')).toHaveLength(1)

    act(() => {
      jest.advanceTimersByTime(INVITE_DONE_MS)
    })

    expect(within(hero).getByRole('button', { name: 'Запросити друзів' })).toBeEnabled()
  })

  it('помилка створення — повідомлення під кнопкою, кнопка знову доступна', async () => {
    const user = userEvent.setup()

    inviteAnswer = () =>
      Promise.reject(
        new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запрошень' }),
      )
    renderProfile()

    const hero = await screen.findByRole('region', { name: 'Профіль' })

    await user.click(within(hero).getByRole('button', { name: 'Запросити друзів' }))

    expect(await within(hero).findByRole('alert')).toHaveTextContent(
      'Не вдалося створити посилання. Забагато запрошень',
    )
    expect(within(hero).getByRole('button', { name: 'Запросити друзів' })).toBeEnabled()
  })
})

describe('ProfileScreen: сесія', () => {
  it('поки сесія перевіряється, показує завантаження і не читає зведення', () => {
    apiRequest.mockImplementation(() => new Promise(() => undefined))
    renderProfile()

    expect(screen.getByText('Завантажую профіль…')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Редагувати профіль' })).not.toBeInTheDocument()
    expect(summaryReads()).toBe(0)
  })

  it('гостя переадресовує на логін', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: '' }))
    renderProfile()

    expect(await screen.findByText('Потрібен вхід. Переадресовую…')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })
    expect(screen.queryByRole('link', { name: 'Редагувати профіль' })).not.toBeInTheDocument()
  })

  it('збій перевірки сесії показує помилку, а не переадресацію', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервіс недоступний' }),
    )
    renderProfile()

    expect(await screen.findByText('Сервіс недоступний')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
