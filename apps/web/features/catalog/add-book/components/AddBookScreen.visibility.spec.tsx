/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type {
  AddSearchExternalItem,
  ApiErrorCode,
  QuickAddRequest,
  Visibility,
} from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import { AddBookScreen } from './AddBookScreen'

/**
 * BS-79: «Кому показувати» нового примірника в повних формах /catalog/new. Форма починає з видимості
 * бібліотеки поточного користувача (невідоме → FRIENDS) рівно один раз; вибір — лише чернетка цього
 * примірника, надсилається явно (`copy.visibility`) і заморожується з операцією. Діалог пошуку видимості
 * не надсилає — її, як і раніше, вирішує сервер.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

jest.mock('../lib/load-barcode-scanner-panel', () => ({
  loadBarcodeScannerPanel: () => Promise.resolve(() => null),
}))

type MockSession = {
  status: 'authenticated'
  user: { id: string; displayName: string; email: string; libraryVisibility?: unknown }
}

function sessionOf(libraryVisibility: unknown, id = 'me'): MockSession {
  return {
    status: 'authenticated',
    user: { id, displayName: 'Тест', email: `${id}@example.com`, libraryVisibility },
  }
}

let mockSession: MockSession = sessionOf('FRIENDS')
const mockSessionListeners = new Set<() => void>()

/** A profile update or another login in the same tab: every reader of the session re-renders. */
function setSession(next: MockSession): void {
  act(() => {
    mockSession = next
    mockSessionListeners.forEach((listener) => {
      listener()
    })
  })
}

jest.mock('@/app/lib/use-session', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react')

  return {
    useSession: () => ({
      state: useSyncExternalStore(
        (listener) => {
          mockSessionListeners.add(listener)

          return () => {
            mockSessionListeners.delete(listener)
          }
        },
        () => mockSession,
        () => mockSession,
      ),
      reload: jest.fn(),
      setUser: jest.fn(),
    }),
  }
})

let searchParams = new URLSearchParams()
const push = jest.fn()
const navigationListeners = new Set<() => void>()

function navigate(href: string): void {
  searchParams = new URLSearchParams(href.split('?')[1] ?? '')
  navigationListeners.forEach((listener) => {
    listener()
  })
}

jest.mock('next/navigation', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react')

  return {
    useRouter: () => ({
      push: (href: string) => {
        push(href)
        if (href !== '/library') navigate(href)
      },
      replace: (href: string) => {
        navigate(href)
      },
    }),
    useSearchParams: () =>
      useSyncExternalStore(
        (listener) => {
          navigationListeners.add(listener)

          return () => {
            navigationListeners.delete(listener)
          }
        },
        () => searchParams,
        () => searchParams,
      ),
  }
})

const { apiRequest: mockApiRequest, apiRequestWithRedirect: mockApiRequestWithRedirect } =
  jest.requireMock<{ apiRequest: jest.Mock; apiRequestWithRedirect: jest.Mock }>('@/app/lib/api')

const LABELS: Readonly<Record<Visibility, string>> = {
  PUBLIC: 'Публічно — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватно — тільки я',
}

const WORK = {
  id: 'work-1',
  title: 'Кобзар',
  origLang: 'uk',
  firstPubYear: 1840,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}
const AUTHORS = [
  { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR' as const, position: 0 },
]
const EDITION = {
  id: 'e-1',
  workId: 'work-1',
  translationId: null,
  textKind: 'ORIGINAL' as const,
  publisher: 'Наука',
  year: 2019,
  isbn13: '9783161484100',
  pageCount: 320,
  coverUrl: null,
  format: 'HARDCOVER' as const,
  lang: 'uk',
  translator: null,
  revision: 1,
}

function addedResponse(body: QuickAddRequest) {
  return {
    operationId: body.operationId,
    replayed: false,
    copy: {
      id: `copy-${body.operationId.slice(0, 4)}`,
      status: 'AVAILABLE',
      visibility: body.copy?.visibility ?? 'FRIENDS',
      condition: 'GOOD',
      note: null,
      acquiredAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      isHome: true,
      holder: null,
      activeLoan: null,
      pendingRequestCount: 0,
    },
    edition: EDITION,
    work: WORK,
    authors: AUTHORS,
  }
}

let quickAddHandler: (body: QuickAddRequest) => Promise<unknown>
let searchItems: unknown[]
let externalItems: AddSearchExternalItem[]

function quickAddCalls(): QuickAddRequest[] {
  return mockApiRequest.mock.calls
    .filter(([path]) => path === '/me/library/quick-add')
    .map(([, options]) => (options as { body: QuickAddRequest }).body)
}

/** Everything the screen sent besides searching: the profile is never among it. */
function nonSearchCalls(): string[] {
  return [...mockApiRequestWithRedirect.mock.calls, ...mockApiRequest.mock.calls]
    .map(
      ([path, options]) =>
        `${(options as { method?: string } | undefined)?.method ?? 'GET'} ${String(path)}`,
    )
    .filter((call) => !call.startsWith('GET /me/library/add-search'))
}

const externalResponse = () =>
  Promise.resolve({
    items: externalItems,
    sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
    page: 1,
    pageSize: 10,
    more: 'NO',
    complete: true,
  })

beforeEach(() => {
  jest.clearAllMocks()
  window.sessionStorage.clear()
  mockSession = sessionOf('FRIENDS')
  searchParams = new URLSearchParams('mode=manual&title=Нова книжка')
  searchItems = []
  externalItems = []
  quickAddHandler = (body) => Promise.resolve(addedResponse(body))
  mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
    if (path.startsWith('/me/library/add-search/suggest/external?')) return externalResponse()
    if (path.startsWith('/me/library/add-search/external?')) return externalResponse()
    if (path.startsWith('/me/library/add-search')) {
      return Promise.resolve({
        items: searchItems,
        page: 1,
        pageSize: 10,
        total: searchItems.length,
        hasMore: false,
      })
    }
    if (path === '/me/library/quick-add') return quickAddHandler(options?.body as QuickAddRequest)

    return Promise.reject(new Error(`Неочікуваний запит ${path}`))
  })
  mockApiRequestWithRedirect.mockImplementation((path: string) =>
    path === '/works/work-1'
      ? Promise.resolve({
          data: {
            work: WORK,
            authors: AUTHORS,
            translations: [],
            editions: [EDITION],
            viewerCapabilities: {
              canEditWork: false,
              editableEditionIds: [],
              editableTranslationIds: [],
            },
          },
          redirected: false,
        })
      : Promise.reject(new Error(`Неочікуваний запит ${path}`)),
  )
})

function renderScreen() {
  return render(withQueryClient(<AddBookScreen />))
}

function visibilityField(): Promise<HTMLElement> {
  return screen.findByRole('combobox', { name: 'Кому показувати' })
}

async function expectShown(visibility: Visibility): Promise<void> {
  expect(await visibilityField()).toHaveTextContent(LABELS[visibility])
}

type User = ReturnType<typeof userEvent.setup>

async function choose(user: User, visibility: Visibility): Promise<void> {
  await chooseOption(user, 'Кому показувати', LABELS[visibility])
  await expectShown(visibility)
}

async function submit(user: User): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
}

const rejectWith = (status: number, code: ApiErrorCode, details?: unknown) =>
  Promise.reject(
    new ApiRequestError(status, {
      code,
      message: `Відмова ${code}`,
      ...(details ? { details } : {}),
    }),
  )

describe('ручна форма: початкове значення з профілю', () => {
  it.each<Visibility>(['PUBLIC', 'FRIENDS', 'PRIVATE'])(
    'профіль %s → «Ваш примірник» починає з нього й надсилає його явно',
    async (visibility) => {
      mockSession = sessionOf(visibility)

      const user = userEvent.setup()

      renderScreen()

      const section = await screen.findByRole('region', { name: 'Ваш примірник' })

      expect(within(section).getByRole('combobox', { name: 'Кому показувати' })).toHaveTextContent(
        LABELS[visibility],
      )

      await submit(user)
      await screen.findByText('Книжку додано до вашої бібліотеки.')

      expect(quickAddCalls()).toEqual([expect.objectContaining({ copy: { visibility } })])
    },
  )

  it.each([undefined, null, 'SECRET'])(
    'відсутнє чи невалідне значення профілю (%p) → FRIENDS',
    async (libraryVisibility) => {
      mockSession = sessionOf(libraryVisibility)

      const user = userEvent.setup()

      renderScreen()
      await expectShown('FRIENDS')
      await submit(user)
      await screen.findByText('Книжку додано до вашої бібліотеки.')

      expect(quickAddCalls()[0]?.copy).toEqual({ visibility: 'FRIENDS' })
    },
  )
})

describe('ручна форма: вибір людини', () => {
  it('надсилається замість значення профілю; профіль не змінюється й не запитується', async () => {
    mockSession = sessionOf('PUBLIC')

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]?.copy).toEqual({ visibility: 'PRIVATE' })
    // Only the add itself: no PATCH /me, no profile read.
    expect(nonSearchCalls()).toEqual(['POST /me/library/quick-add'])
  })

  it('оновлення профілю під час відкритої форми не скидає ні незайманий, ні змінений вибір', async () => {
    mockSession = sessionOf('PUBLIC')

    const user = userEvent.setup()

    renderScreen()
    await expectShown('PUBLIC')

    setSession(sessionOf('PRIVATE'))
    await expectShown('PUBLIC')

    await choose(user, 'FRIENDS')
    setSession(sessionOf('PUBLIC'))
    await expectShown('FRIENDS')

    await submit(user)
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]?.copy).toEqual({ visibility: 'FRIENDS' })
  })

  it('нова форма після успіху читає оновлене значення профілю', async () => {
    mockSession = sessionOf('PUBLIC')

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'FRIENDS')
    await submit(user)
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    setSession(sessionOf('PRIVATE'))
    await user.click(screen.getByRole('button', { name: 'Додати ще одну книжку' }))

    await expectShown('PRIVATE')
  })

  it('помилка валідації лишає вибір; запиту немає', async () => {
    searchParams = new URLSearchParams('mode=manual')

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PRIVATE')
    await submit(user)

    expect(await screen.findByText('Вкажіть назву')).toBeInTheDocument()
    await expectShown('PRIVATE')
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('однозначна відмова сервера лишає вибір; виправлена спроба надсилає його ж', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? rejectWith(422, 'VALIDATION_ERROR')
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PUBLIC')
    await submit(user)

    expect(await screen.findByText('Відмова VALIDATION_ERROR')).toBeInTheDocument()
    await expectShown('PUBLIC')

    await submit(user)
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
    expect(second?.copy).toEqual({ visibility: 'PUBLIC' })
  })

  it('ISBN уже є в каталозі: «Додати наявне видання» надсилає вибрану видимість', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? rejectWith(409, 'EDITION_ISBN_TAKEN', { editionId: 'e-existing' })
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText('Видання з таким ISBN уже є в каталозі BookSwap.')
    await expectShown('PRIVATE')
    await user.click(screen.getByRole('button', { name: 'Додати наявне видання' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[1]).toMatchObject({
      copy: { visibility: 'PRIVATE' },
      target: { kind: 'EXISTING_EDITION', editionId: 'e-existing' },
    })
  })
})

describe('ручна форма: операція й повтор', () => {
  it('невизначений результат: вибір заблоковано з надісланим значенням; повтор — той самий operationId і вміст', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)

    expect(await visibilityField()).toBeDisabled()
    await expectShown('PRIVATE')

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const [first, second] = quickAddCalls()

    expect(first?.copy).toEqual({ visibility: 'PRIVATE' })
    expect(second).toEqual(first)
  })

  it('поки запит у польоті, вибір заблоковано', async () => {
    quickAddHandler = () => new Promise(() => undefined)

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PUBLIC')
    await submit(user)
    await screen.findByRole('button', { name: 'Додаю…' })

    expect(await visibilityField()).toBeDisabled()
    await expectShown('PUBLIC')
  })

  it('відновлена після перезавантаження операція зберігає вихідну видимість і operationId попри новий профіль', async () => {
    mockSession = sessionOf('PUBLIC')
    quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

    const user = userEvent.setup()
    const first = renderScreen()

    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)

    const interrupted = quickAddCalls()[0]

    first.unmount()
    mockSession = sessionOf('FRIENDS')
    quickAddHandler = () => new Promise(() => undefined)
    renderScreen()

    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })
    expect(quickAddCalls()[1]).toEqual(interrupted)
    expect(interrupted?.copy).toEqual({ visibility: 'PRIVATE' })
    // The restored operation, not the new preference, is what the locked selector shows.
    await expectShown('PRIVATE')
    expect(await visibilityField()).toBeDisabled()
  })

  it('інший акаунт у тій самій вкладці не бачить чужої чернетки', async () => {
    mockSession = sessionOf('FRIENDS', 'alice')

    const user = userEvent.setup()

    renderScreen()
    await choose(user, 'PRIVATE')

    setSession(sessionOf('PUBLIC', 'bob'))
    await expectShown('PUBLIC')

    await submit(user)
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()).toEqual([expect.objectContaining({ copy: { visibility: 'PUBLIC' } })])
  })
})

/**
 * Regression: an operation restored after a reload and then rejected unambiguously must give the form back
 * the visibility it was sent with — not the profile's — once, editable, for the next (new) operation.
 */
const RESTORABLE_FORMS = [
  {
    name: 'ручне додавання',
    params: 'mode=manual&title=Нова книжка',
    ready: () => screen.findByRole('heading', { name: 'Додати книжку вручну' }),
  },
  {
    name: 'уточнення наявного видання',
    params: 'mode=manual&editionId=e-1&workId=work-1&q=кобзар',
    ready: () => screen.findByRole('region', { name: 'Видання' }),
  },
] as const

/** How the recovery's rejection arrives: at once, or after the locked state was on screen. */
type RecoveryTiming = 'одразу' | 'після очікування'

describe.each(RESTORABLE_FORMS)('відновлена операція, яку сервер відхилив: $name', (form) => {
  beforeEach(() => {
    searchParams = new URLSearchParams(form.params)
    mockSession = sessionOf('PUBLIC')
  })

  /** PUBLIC profile, PRIVATE chosen, outcome unknown, page reloaded: the stored request is recovered. */
  async function interruptAndReload(timing: RecoveryTiming): Promise<QuickAddRequest> {
    quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

    const user = userEvent.setup()
    const first = renderScreen()

    await form.ready()
    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)

    const interrupted = quickAddCalls()[0]

    if (interrupted === undefined) throw new Error('Перший запит не надіслано')

    first.unmount()

    let rejectRecovery: (() => void) | undefined
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      if (attempt > 1) return Promise.resolve(addedResponse(body))
      if (timing === 'одразу') return rejectWith(400, 'VALIDATION_ERROR')

      return new Promise((_resolve, reject) => {
        rejectRecovery = () => {
          reject(
            new ApiRequestError(400, {
              code: 'VALIDATION_ERROR',
              message: 'Відмова VALIDATION_ERROR',
            }),
          )
        }
      })
    }
    renderScreen()

    if (timing === 'після очікування') {
      await waitFor(() => {
        expect(rejectRecovery).toBeDefined()
      })
      await expectShown('PRIVATE')
      expect(await visibilityField()).toBeDisabled()
      act(() => {
        rejectRecovery?.()
      })
    }

    expect(await screen.findByText('Відмова VALIDATION_ERROR')).toBeInTheDocument()

    return interrupted
  }

  it.each<RecoveryTiming>(['одразу', 'після очікування'])(
    'відмова %s: вибір лишається PRIVATE і відкривається; наступна спроба — PRIVATE з новим operationId',
    async (timing) => {
      const interrupted = await interruptAndReload(timing)

      // The recovery sent the stored request unchanged.
      expect(quickAddCalls()[1]).toEqual(interrupted)
      expect(interrupted.copy).toEqual({ visibility: 'PRIVATE' })

      await expectShown('PRIVATE')
      expect(await visibilityField()).toBeEnabled()

      await submit(userEvent.setup())
      await waitFor(() => {
        expect(quickAddCalls()).toHaveLength(3)
      })

      const next = quickAddCalls()[2]

      expect(next?.copy).toEqual({ visibility: 'PRIVATE' })
      expect(next?.operationId).not.toBe(interrupted.operationId)
    },
  )

  it('після відмови вибір людини не перезаписується відновленим значенням і надсилається', async () => {
    await interruptAndReload('одразу')

    const user = userEvent.setup()

    await choose(user, 'FRIENDS')
    // Neither a re-render nor a profile update brings the restored value back.
    setSession(sessionOf('PRIVATE'))
    await expectShown('FRIENDS')

    await submit(user)
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(3)
    })

    expect(quickAddCalls()[2]?.copy).toEqual({ visibility: 'FRIENDS' })
  })

  it('інший акаунт після відновленої відмови бачить лише свій профіль', async () => {
    await interruptAndReload('одразу')
    await expectShown('PRIVATE')

    setSession(sessionOf('FRIENDS', 'bob'))

    await expectShown('FRIENDS')
    expect(await visibilityField()).toBeEnabled()
  })
})

describe('відновлена операція діалогу пошуку без видимості', () => {
  it('після відмови «Уточнити дані» лишає значення профілю й надсилає його явно', async () => {
    mockSession = sessionOf('PUBLIC')
    searchParams = new URLSearchParams('q=кобзар')
    searchItems = [
      {
        kind: 'EDITION',
        key: 'edition:e-1',
        edition: EDITION,
        work: WORK,
        authors: AUTHORS,
        matchedOn: 'TITLE',
        ownership: { activeCount: 0, archivedCount: 0 },
      },
    ]
    quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

    const user = userEvent.setup()
    const first = renderScreen()
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("li[data-slot='result-card']")

      if (found === null) throw new Error('Картки ще немає')

      return found
    })

    await user.click(within(card).getByRole('button'))

    const dialog = await screen.findByRole('dialog')

    await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByText(/Не вдалося підтвердити додавання/)

    const interrupted = quickAddCalls()[0]

    expect(interrupted).not.toHaveProperty('copy')

    first.unmount()

    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? rejectWith(400, 'VALIDATION_ERROR')
        : Promise.resolve(addedResponse(body))
    }
    searchParams = new URLSearchParams('mode=manual&editionId=e-1&workId=work-1&q=кобзар')
    renderScreen()

    expect(await screen.findByText('Відмова VALIDATION_ERROR')).toBeInTheDocument()
    expect(quickAddCalls()[1]).toEqual(interrupted)
    await expectShown('PUBLIC')

    await submit(user)
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(3)
    })

    expect(quickAddCalls()[2]?.copy).toEqual({ visibility: 'PUBLIC' })
  })
})

describe('«Уточнити дані» наявного видання', () => {
  beforeEach(() => {
    searchParams = new URLSearchParams('mode=manual&editionId=e-1&workId=work-1&q=кобзар')
  })

  it.each<Visibility>(['PUBLIC', 'FRIENDS', 'PRIVATE'])(
    'профіль %s → починає з нього',
    async (visibility) => {
      mockSession = sessionOf(visibility)
      renderScreen()

      await expectShown(visibility)
    },
  )

  it('вибір людини йде з EXISTING_EDITION; профіль не змінюється', async () => {
    mockSession = sessionOf('PRIVATE')

    const user = userEvent.setup()

    renderScreen()
    await screen.findByRole('region', { name: 'Видання' })
    await choose(user, 'PUBLIC')
    setSession(sessionOf('FRIENDS'))
    await expectShown('PUBLIC')
    await submit(user)
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/library')
    })

    expect(quickAddCalls()).toEqual([
      expect.objectContaining({
        copy: { visibility: 'PUBLIC' },
        target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
      }),
    ])
    expect(nonSearchCalls()).toEqual(['GET /works/work-1', 'POST /me/library/quick-add'])
  })

  it('поки додавання не з’ясоване — вибір заблоковано, повтор несе ту саму видимість', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await screen.findByRole('region', { name: 'Видання' })
    await choose(user, 'PRIVATE')
    await submit(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)

    expect(await visibilityField()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })

    const [first, second] = quickAddCalls()

    expect(first?.copy).toEqual({ visibility: 'PRIVATE' })
    expect(second).toEqual(first)
  })
})

describe('«Уточнити дані» зовнішнього результату', () => {
  it('ручна форма з записом джерела теж надсилає вибір людини', async () => {
    mockSession = sessionOf('PUBLIC')
    searchParams = new URLSearchParams('q=кобзар')
    externalItems = [
      {
        kind: 'EXTERNAL',
        key: 'external:GOOGLE_BOOKS:vol-1',
        result: {
          id: 'GOOGLE_BOOKS:vol-1',
          kind: 'EDITION',
          sources: ['GOOGLE_BOOKS'],
          title: 'Зовнішня книжка',
          authors: ['Якийсь Автор'],
          isbn13: '9780306406157',
        },
      },
    ]

    const user = userEvent.setup()

    renderScreen()

    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("li[data-slot='result-card']")

      if (found === null) throw new Error('Картки ще немає')

      return found
    })

    await user.click(within(card).getByRole('button'))

    const dialog = await screen.findByRole('dialog')
    const href = within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href')

    act(() => {
      navigate(href ?? '')
    })
    await screen.findByRole('heading', { name: 'Додати книжку вручну' })
    await expectShown('PUBLIC')
    await choose(user, 'FRIENDS')
    await submit(user)
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })

    expect(quickAddCalls()[0]).toMatchObject({
      copy: { visibility: 'FRIENDS' },
      target: { kind: 'EXTERNAL_EDITION', isbn13: '9780306406157' },
    })
  })
})

describe('діалог пошуку (поза BS-79)', () => {
  it('швидке додавання не надсилає видимості навіть для публічного профілю — її вирішує сервер', async () => {
    mockSession = sessionOf('PUBLIC')
    searchParams = new URLSearchParams('q=кобзар')
    searchItems = [
      {
        kind: 'EDITION',
        key: 'edition:e-1',
        edition: EDITION,
        work: WORK,
        authors: AUTHORS,
        matchedOn: 'TITLE',
        ownership: { activeCount: 0, archivedCount: 0 },
      },
    ]

    const user = userEvent.setup()

    renderScreen()

    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("li[data-slot='result-card']")

      if (found === null) throw new Error('Картки ще немає')

      return found
    })

    await user.click(within(card).getByRole('button'))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).queryByRole('combobox', { name: 'Кому показувати' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).not.toHaveProperty('copy')
  })
})
