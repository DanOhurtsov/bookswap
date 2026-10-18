/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type {
  AddSearchEditionItem,
  AddSearchExternalItem,
  AddSearchItem,
  AddSearchResponse,
  BookLookupResult,
  QuickAddResponse,
} from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption, searchAndChooseOption } from '@/components/Form/test-choose-option'
import { AddBookScreen } from './AddBookScreen'

/**
 * Екран додавання (docs/plan/fast-book-add.md, §2.1–2.3, QA1, QA6, QA8, QA9; BS-114): одна картка = одне
 * видання; вибір картки відкриває діалог, у якому «Додати до бібліотеки» → «Додаю…» → «✓ У моїй бібліотеці»,
 * користувач лишається в результатах, повтор після невизначеного результату йде тією самою операцією.
 *
 * jsdom підтверджує стани, обробники клавіатури, Escape і керування фокусом; реальну адаптивну верстку,
 * прокрутку, touch і браузерний фокус він НЕ підтверджує — вони позначені NOT RUN у runbook.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

jest.mock('../lib/load-barcode-scanner-panel', () => ({
  loadBarcodeScannerPanel: () =>
    Promise.resolve(({ onValidIsbn }: { onValidIsbn: (isbn: string) => void }) => (
      <button type="button" onClick={() => onValidIsbn('9783161484100')}>
        Simulate scan
      </button>
    )),
}))

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: {
      status: 'authenticated',
      user: { id: 'me', displayName: 'Тест', email: 't@example.com', libraryVisibility: 'FRIENDS' },
    },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

let searchParams = new URLSearchParams()
const push = jest.fn()
const replace = jest.fn()
const navigationListeners = new Set<() => void>()

/** Робочий мок роутера: `push` рухає адресу й перемальовує тих, хто її читає (як справжній). */
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
        // `/library` — інша сторінка: екран додавання в тесті лишається, як і його адреса.
        if (href !== '/library') navigate(href)
      },
      // Як у справжнього роутера: `replace` теж міняє адресу (автопошук пише її сам), лише без запису в історію.
      replace: (href: string, options?: { scroll?: boolean }) => {
        replace(href, options)
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

beforeAll(() => {
  // jsdom не має `showModal`; підтвердження закриття панелі — нативний `<dialog>`.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

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

function editionItem(
  id: string,
  overrides: Partial<AddSearchEditionItem> & { isbn13?: string | null; year?: number } = {},
): AddSearchEditionItem {
  const { isbn13 = '9783161484100', year = 2019, ...rest } = overrides

  return {
    kind: 'EDITION',
    key: `edition:${id}`,
    edition: {
      id,
      workId: 'work-1',
      translationId: null,
      textKind: 'ORIGINAL',
      publisher: 'Наука',
      year,
      isbn13,
      pageCount: 320,
      coverUrl: null,
      format: 'HARDCOVER',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
    work: WORK,
    authors: AUTHORS,
    matchedOn: 'TITLE',
    ownership: { activeCount: 0, archivedCount: 0 },
    ...rest,
  }
}

function searchResponse(items: AddSearchItem[], extra: Partial<AddSearchResponse> = {}) {
  return { items, page: 1, pageSize: 10, total: items.length, hasMore: false, ...extra }
}

function addedResponse(body: {
  operationId: string
  target: { editionId: string }
}): QuickAddResponse {
  return {
    operationId: body.operationId,
    replayed: false,
    copy: {
      id: `copy-${body.operationId.slice(0, 4)}`,
      status: 'AVAILABLE',
      visibility: 'FRIENDS',
      condition: 'GOOD',
      note: null,
      acquiredAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      isHome: true,
      holder: null,
      activeLoan: null,
      pendingRequestCount: 0,
    },
    edition: editionItem(body.target.editionId).edition,
    work: WORK,
    authors: AUTHORS,
  }
}

type QuickAddBody = { operationId: string; entryMethod: string; target: { editionId: string } }

function quickAddCalls(): QuickAddBody[] {
  return mockApiRequest.mock.calls
    .filter(([path]) => path === '/me/library/quick-add')
    .map(([, options]) => (options as { body: QuickAddBody }).body)
}

/** Картки результатів; `<li>` усередині «Деталей видання» ними не вважаються. */
function cardAt(index: number): HTMLElement {
  const card = document.querySelectorAll<HTMLElement>("li[data-slot='result-card']")[index]

  if (card === undefined) throw new Error(`Картки №${String(index)} немає`)

  return card
}

/** BS-114: the card's one button chooses the result; its dialog holds the details and the actions. */
async function openCard(user: User, index = 0): Promise<HTMLElement> {
  const choose = await waitFor(() => within(cardAt(index)).getByRole('button'))

  await user.click(choose)

  return screen.findByRole('dialog')
}

function linkHref(name: string): string {
  return screen.getByRole('link', { name }).getAttribute('href') ?? ''
}

/** Opens the card and presses «Додати до бібліотеки» in its dialog. */
async function addFromCard(user: User, index = 0): Promise<HTMLElement> {
  const dialog = await openCard(user, index)

  await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))

  return dialog
}

let items: AddSearchItem[]
/** Додаткові поля відповіді повного пошуку (наприклад, `spellingSuggestion`). */
let fullExtra: Partial<AddSearchResponse>
let externalItems: AddSearchExternalItem[]
/** Зовнішня половина повного пошуку; `q` і `page` — щоб тест міг відповідати на різні тексти й сторінки по-різному. */
let externalHandler: (query: string, page: number) => Promise<unknown>
let lookupHandler: () => Promise<{ result: BookLookupResult }>
let quickAddHandler: (body: QuickAddBody) => Promise<QuickAddResponse>
/** Локальна половина повного пошуку; `q` і `page` — як у зовнішньої. */
let localHandler: (query: string, page: number) => Promise<unknown>

beforeEach(() => {
  jest.clearAllMocks()
  window.sessionStorage.clear()
  searchParams = new URLSearchParams('q=кобзар')
  items = [editionItem('e-1')]
  fullExtra = {}
  externalItems = []
  externalHandler = () =>
    Promise.resolve({
      items: externalItems,
      sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
      page: 1,
      pageSize: 10,
      more: 'NO',
      complete: true,
    })
  lookupHandler = () => Promise.reject(new Error('lookup не очікувався'))
  quickAddHandler = (body) => Promise.resolve(addedResponse(body))
  localHandler = () => Promise.resolve(searchResponse(items, fullExtra))
  mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
    // The suggestion endpoints (`…/add-search/suggest*`) are not handled: since BS-134 nothing asks them.
    if (path.startsWith('/me/library/add-search?')) return localHandler(queryOf(path), pageOf(path))
    if (path.startsWith('/me/library/add-search/external?')) {
      return externalHandler(queryOf(path), pageOf(path))
    }
    if (path.startsWith('/catalog/lookup?')) return lookupHandler()
    if (path === '/me/library/quick-add') return quickAddHandler(options?.body as QuickAddBody)

    return Promise.reject(new Error(`Неочікуваний запит ${path}`))
  })
})

function queryOf(path: string): string {
  return decodeURIComponent(new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '')
}

function pageOf(path: string): number {
  return Number(new URLSearchParams(path.split('?')[1] ?? '').get('page') ?? '1')
}

function renderScreen() {
  return render(withQueryClient(<AddBookScreen />))
}

type User = ReturnType<typeof userEvent.setup>

/** BS-76: a manual-form field reads as text inside a group named by the field. */
function manualField(label: string): Promise<HTMLElement> {
  return screen.findByRole('group', { name: label })
}

/**
 * Opens a manual-form field's editor — its own action: the pencil, or «Додати …» when it is empty.
 * Named, not "the group's button": the ISBN row also holds the scanner.
 */
async function openManualEditor(user: User, label: string): Promise<void> {
  const field = within(await manualField(label))

  await user.click(
    field.queryByRole('button', { name: `Редагувати: ${label}` }) ??
      field.getByRole('button', { name: /^Додати/ }),
  )
}

describe('результати: одна картка — одне видання', () => {
  it('питає локальний пошук з q, page і pageSize та показує ознаки видання', async () => {
    renderScreen()

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/add-search?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=1&pageSize=12',
      expect.anything(),
    )
    expect(screen.getByText('Тарас Шевченко')).toBeInTheDocument()
    expect(screen.getByText(/Наука/)).toBeInTheDocument()
    expect(screen.getByText(/2019/)).toBeInTheDocument()
    expect(screen.getByText(/українська/)).toBeInTheDocument()
    // The card is chosen by its title; the actions are in its dialog, which nothing opens by itself.
    expect(screen.getByRole('button', { name: 'Кобзар' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ISBN і джерело — у діалозі; невідомі поля не вигадуються', async () => {
    items = [editionItem('e-1', { isbn13: null })]
    renderScreen()

    await screen.findByText('Кобзар')

    const dialog = await openCard(userEvent.setup())

    expect(within(dialog).queryByText(/ISBN/)).not.toBeInTheDocument()
    expect(within(dialog).getByText('Джерело: каталог BookSwap')).toBeInTheDocument()
  })

  it('твір без видання — не конкретна книжка: кнопки додавання немає', async () => {
    items = [
      {
        kind: 'WORK',
        key: 'work:w-9',
        work: { ...WORK, id: 'w-9', title: 'Абстрактний твір' },
        authors: [],
        matchedOn: 'TITLE',
      },
    ]
    renderScreen()

    await screen.findByText('Абстрактний твір')

    expect(screen.getByText('Для цього твору ще немає конкретного видання.')).toBeInTheDocument()

    const dialog = await openCard(userEvent.setup())

    // Nothing to add — only «Уточнити дані», no edition or ISBN taken at random.
    expect(within(dialog).queryByRole('button', { name: /Додати/ })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Це запис про твір, а не про конкретне видання/)).toBeVisible()
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Уточнити дані'])
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('порожня відповідь на першій сторінці — повідомлення, а не помилка', async () => {
    items = []
    renderScreen()

    expect(await screen.findByText('Нічого схожого не знайшлося.')).toBeInTheDocument()
  })

  it('збій пошуку показує помилку', async () => {
    mockApiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій пошуку' }),
    )
    renderScreen()

    expect(await screen.findByText('Збій пошуку')).toBeInTheDocument()
  })
})

describe('одне натискання (QA1)', () => {
  it('«Додати до бібліотеки» → «Додаю…» → «✓ У моїй бібліотеці»; користувач лишається в результатах', async () => {
    let finish: (() => void) | undefined

    quickAddHandler = (body) =>
      new Promise((resolve) => {
        finish = () => {
          resolve(addedResponse(body))
        }
      })

    const user = userEvent.setup()

    renderScreen()

    const dialog = await addFromCard(user)

    expect(await within(dialog).findByRole('button', { name: 'Додаю…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(cardAt(0)).getByText('Додаю…')).toBeInTheDocument()
    expect(screen.queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()

    await act(async () => {
      finish?.()
    })

    // BS-114: the dialog stays open with the confirmation, and the card shows the new state.
    expect(
      await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' }),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Книжку додано до вашої бібліотеки.',
    )
    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBe(dialog)
    // No transition, no change to the search address.
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('надсилає одну операцію з operationId, видом цілі та способом додавання', async () => {
    const user = userEvent.setup()

    renderScreen()
    await addFromCard(user)
    await screen.findAllByText('✓ У моїй бібліотеці')

    const [call, ...rest] = quickAddCalls()

    expect(rest).toHaveLength(0)
    expect(call).toMatchObject({
      entryMethod: 'MANUAL',
      target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
    })
    expect(call?.operationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('подвійний клік — один запит', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openCard(user)

    await user.dblClick(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })
    // Pressing the same button again after the success adds nothing either.
    await user.click(within(dialog).getByRole('button', { name: '✓ У моїй бібліотеці' }))

    expect(quickAddCalls()).toHaveLength(1)
  })

  it('після сканування спосіб додавання — BARCODE', async () => {
    searchParams = new URLSearchParams()

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))
    await screen.findByText('Кобзар')
    await addFromCard(user)
    await screen.findAllByText('✓ У моїй бібліотеці')

    expect(quickAddCalls()[0]?.entryMethod).toBe('BARCODE')
  })

  it('видання, яке вже є в бібліотеці, показується відразу; ще один примірник — явна нова операція', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 1, archivedCount: 0 } })]

    const user = userEvent.setup()

    renderScreen()

    expect(await screen.findByText('✓ У моїй бібліотеці')).toBeInTheDocument()

    const dialog = await openCard(user)

    expect(within(dialog).getByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Додати до бібліотеки' })).toBeNull()
    // Refining an owned edition would silently add a second copy: not offered.
    expect(within(dialog).queryByRole('link', { name: 'Уточнити дані' })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })
    await within(dialog).findByRole('status')
    await waitFor(() => {
      expect(within(dialog).getByRole('status')).toHaveTextContent('Книжку додано')
    })
    expect(push).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
  })

  it('інше видання того самого твору не вважається вже доданим', async () => {
    items = [
      editionItem('e-1', { ownership: { activeCount: 1, archivedCount: 0 } }),
      editionItem('e-2', { isbn13: null, year: 2010 }),
    ]
    renderScreen()

    await screen.findAllByText('Кобзар')

    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(within(cardAt(1)).queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()

    const dialog = await openCard(userEvent.setup(), 1)

    expect(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
  })

  it('архівний примірник — окремий стан із переходом до відновлення; додати можна й новий', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 0, archivedCount: 1 } })]
    renderScreen()

    expect(await screen.findByText('Є у вашому архіві')).toBeInTheDocument()

    const dialog = await openCard(userEvent.setup())

    expect(within(dialog).getByRole('link', { name: 'Відновити з архіву' })).toHaveAttribute(
      'href',
      '/library?view=archive',
    )
    expect(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
    expect(screen.queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()
  })
})

describe('повтор, відмова й невизначений результат (QA4, QA9)', () => {
  it('невизначений результат: нової операції немає, повтор іде тим самим operationId і вмістом', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()

    const dialog = await addFromCard(user)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Не вдалося підтвердити додавання/,
    )
    expect(screen.queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()
    // «Уточнити дані» would start a different operation: not while this one is unresolved.
    expect(within(dialog).queryByRole('link', { name: 'Уточнити дані' })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Перевірити ще раз' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [first, second] = quickAddCalls()

    expect(quickAddCalls()).toHaveLength(2)
    expect(second).toEqual(first)
  })

  it('однозначна відмова 4xx: помилка видна, виправлена дія починає НОВУ операцію', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(
            new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Видання не знайдено' }),
          )
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()

    const dialog = await addFromCard(user)

    // The dialog stays open with an accessible message and the action to try again.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Видання не знайдено')
    expect(within(cardAt(0)).getByText('Не вдалося додати')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
  })

  it('незавершена операція переживає перезавантаження і повторюється тією самою операцією', async () => {
    quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

    const user = userEvent.setup()
    const first = renderScreen()

    await addFromCard(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)

    const interrupted = quickAddCalls()[0]

    first.unmount()
    quickAddHandler = (body) => Promise.resolve(addedResponse(body))
    renderScreen()

    // Started in the search dialog: the confirmed result shows on its card, nobody is carried away.
    await waitFor(() => {
      expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    })
    expect(push).not.toHaveBeenCalled()
    expect(quickAddCalls()).toHaveLength(2)
    expect(quickAddCalls()[1]).toEqual(interrupted)
    expect(window.sessionStorage.length).toBe(0)
  })
})

function externalEdition(
  id: string,
  over: Partial<{
    isbn13: string
    title: string
    kind: 'EDITION' | 'WORK'
    language: string
    publisher: string
  }> = {},
): AddSearchExternalItem {
  const { kind = 'EDITION', title = `Зовнішня ${id}`, ...rest } = over

  return {
    kind: 'EXTERNAL',
    key: `external:GOOGLE_BOOKS:${id}`,
    result: {
      id: `GOOGLE_BOOKS:${id}`,
      kind,
      sources: ['GOOGLE_BOOKS'],
      title,
      authors: ['Якийсь Автор'],
      ...rest,
    },
  }
}

describe('зовнішня половина: перше додавання (QA2, QA9, QA11)', () => {
  beforeEach(() => {
    items = []
  })

  it('картка зовнішнього видання має ту саму одну дію; на сервер іде лише ідентичність, без метаданих', async () => {
    externalItems = [
      externalEdition('vol-1', {
        isbn13: '9783161484100',
        language: 'uk',
        publisher: 'Видавець',
        title: 'Назва із джерела',
      }),
    ]

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Назва із джерела')

    const card = cardAt(0)

    expect(within(card).getByText(/Видавець/)).toBeInTheDocument()
    expect(within(card).getByText(/українська/)).toBeInTheDocument()

    const dialog = await openCard(user)

    // The source's attribution stays with its data.
    expect(within(dialog).getByText('Джерело: Google Books')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [call, ...rest] = quickAddCalls()

    expect(rest).toHaveLength(0)
    expect(call).toMatchObject({
      target: {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: 'vol-1',
        isbn13: '9783161484100',
      },
    })
    // Жодних назв, авторів чи URL із браузера.
    expect(JSON.stringify(call)).not.toContain('Назва із джерела')
  })

  it('запис про ТВІР не видається за видання: кнопки додавання немає', async () => {
    externalItems = [externalEdition('work-1', { kind: 'WORK', title: 'Лише твір' })]
    renderScreen()

    expect(await screen.findByText('Лише твір')).toBeInTheDocument()
    expect(screen.getByText('Запис про твір, а не про конкретне видання.')).toBeInTheDocument()

    const dialog = await openCard(userEvent.setup())

    expect(within(dialog).queryByRole('button', { name: /Додати/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()
  })

  it('видання без ISBN і без ідентифікатора Google Books не можна додати як конкретне', async () => {
    externalItems = [
      {
        kind: 'EXTERNAL',
        key: 'external:OPEN_LIBRARY:OL1M',
        result: {
          id: 'OPEN_LIBRARY:OL1M',
          kind: 'EDITION',
          sources: ['OPEN_LIBRARY'],
          title: 'Без ISBN',
        },
      },
    ]
    renderScreen()

    expect(await screen.findByText('Без ISBN')).toBeInTheDocument()

    const dialog = await openCard(userEvent.setup())

    expect(within(dialog).queryByRole('button', { name: /Додати/ })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Джерело не дало ідентифікатора/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()
  })

  it('наше видання серед зовнішніх результатів — локальна картка з власним станом, без мережі джерела', async () => {
    externalItems = [
      editionItem('e-known', { ownership: { activeCount: 1, archivedCount: 0 } }),
      externalEdition('vol-2'),
    ]
    renderScreen()

    await screen.findByText('Зовнішня vol-2')

    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(within(cardAt(1)).queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()
    expect(
      within(await openCard(userEvent.setup())).getByText('Джерело: каталог BookSwap'),
    ).toBeInTheDocument()
  })

  it('дві картки одного видання діляться станом: один запит, обидві показують «Додаю…» і «✓»', async () => {
    items = [editionItem('e-1', { isbn13: '9783161484100' })]
    externalItems = [externalEdition('vol-same', { isbn13: '9783161484100' })]

    let finish: (() => void) | undefined

    quickAddHandler = (body) =>
      new Promise((resolve) => {
        finish = () => {
          resolve(addedResponse(body))
        }
      })

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Зовнішня vol-same')
    await addFromCard(user, 0)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    expect(within(cardAt(0)).getByText('Додаю…')).toBeInTheDocument()
    expect(within(cardAt(1)).getByText('Додаю…')).toBeInTheDocument()

    // Друга картка того самого видання не може запустити другої операції.
    const second = await openCard(user, 1)

    await user.click(within(second).getByRole('button', { name: 'Додаю…' }))
    expect(quickAddCalls()).toHaveLength(1)

    await act(async () => {
      finish?.()
    })
    await waitFor(() => {
      expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    })
    expect(within(cardAt(1)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(within(second).getByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
  })

  it('збій зовнішніх джерел не блокує місцеві результати й не додає окремих повідомлень', async () => {
    items = [editionItem('e-1')]
    externalHandler = () =>
      Promise.resolve({
        items: [],
        sources: [
          { source: 'OPEN_LIBRARY', status: 'ERROR' },
          { source: 'GOOGLE_BOOKS', status: 'TIMEOUT' },
        ],
        page: 1,
        pageSize: 10,
        more: 'NO',
        complete: true,
      })
    renderScreen()

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Кобзар' })).toBeInTheDocument()
    expect(screen.queryByText(/недоступна|не відповіла вчасно|неповним/)).not.toBeInTheDocument()
  })

  it('нічого немає, а джерела не відповіли: це не «книжки не існує»', async () => {
    items = []
    externalHandler = () =>
      Promise.resolve({
        items: [],
        sources: [
          { source: 'OPEN_LIBRARY', status: 'ERROR' },
          { source: 'GOOGLE_BOOKS', status: 'ERROR' },
        ],
        page: 1,
        pageSize: 10,
        more: 'NO',
        complete: true,
      })
    renderScreen()

    expect(
      await screen.findByText(/зовнішні каталоги не відповіли — чи є там ця книжка, невідомо/),
    ).toBeInTheDocument()
  })
})

describe('пошук за ISBN (сканер): один сценарій', () => {
  const ISBN = '9783161484100'

  beforeEach(() => {
    searchParams = new URLSearchParams(`q=${ISBN}`)
    items = []
    lookupHandler = () =>
      Promise.resolve({
        result: {
          title: 'Знайдена за ISBN',
          authors: ['Автор'],
          publisher: 'Видавець',
          source: 'GOOGLE_BOOKS',
          externalId: 'vol-isbn',
        },
      })
  })

  it('видання, якого немає в каталозі, додається одним натисканням за ISBN', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Знайдена за ISBN')

    const dialog = await addFromCard(user)

    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    expect(within(dialog).getByText('Знайдено за ISBN у Google Books')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).toMatchObject({ target: { kind: 'EXTERNAL_EDITION', isbn13: ISBN } })
  })

  it('другий примірник через ISBN: «Додати ще один примірник» передає additional — нова операція з іншим operationId', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Знайдена за ISBN')
    await addFromCard(user)
    await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })

    await user.click(screen.getByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
    expect(first).toMatchObject({ target: { kind: 'EXTERNAL_EDITION', isbn13: ISBN } })
    expect(second).toMatchObject({ target: { kind: 'EXTERNAL_EDITION', isbn13: ISBN } })

    // Третє — так само, і подвійний клік під час польоту лишається одним запитом.
    await user.click(await screen.findByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(3)
    })
    expect(new Set(quickAddCalls().map((call) => call.operationId)).size).toBe(3)
  })

  it('ISBN-запит — один список: зовнішній пошук за назвою не викликається, картка одна й сторінка не вважається порожньою', async () => {
    externalHandler = () => Promise.reject(new Error('зовнішній пошук за ISBN не очікувався'))
    renderScreen()
    await screen.findByText('Знайдена за ISBN')

    expect(
      mockApiRequest.mock.calls.filter(([path]) =>
        String(path).startsWith('/me/library/add-search/external'),
      ),
    ).toHaveLength(0)
    expect(document.querySelectorAll("li[data-slot='result-card']")).toHaveLength(1)
    expect(screen.queryByText('На цій сторінці результатів немає.')).not.toBeInTheDocument()
    expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()
  })

  it('сканування лише підставляє ISBN і нічого не створює', async () => {
    searchParams = new URLSearchParams()
    items = []

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))
    await screen.findByText('Знайдена за ISBN')

    expect(quickAddCalls()).toHaveLength(0)
  })

  it('коли таке видання вже є в каталозі, картки з джерела немає — лише наша', async () => {
    items = [editionItem('e-isbn', { isbn13: ISBN, matchedOn: 'ISBN' })]
    renderScreen()

    await screen.findByText('Кобзар')

    expect(screen.queryByText('Знайдена за ISBN')).not.toBeInTheDocument()
    expect(document.querySelectorAll("li[data-slot='result-card']")).toHaveLength(1)
  })

  it('джерело недоступне: місцева порожнеча + пояснення, а не хибне «не існує»', async () => {
    lookupHandler = () =>
      Promise.reject(
        new ApiRequestError(502, {
          code: 'CATALOG_LOOKUP_PROVIDER_ERROR',
          message: 'Зовнішній провайдер повернув помилку',
        }),
      )
    renderScreen()

    expect(
      await screen.findByText(/Зовнішній сервіс автозаповнення зараз недоступний/),
    ).toBeInTheDocument()
  })
})

describe('ручне додавання: одна форма (QA9)', () => {
  const MANUAL_ISBN = '9783161484100'

  beforeEach(() => {
    searchParams = new URLSearchParams('mode=manual&title=Нова книжка')
    items = []
  })

  it('«Додати вручну» доступне завжди — навіть коли зовнішні джерела не відповіли', async () => {
    searchParams = new URLSearchParams('q=кобзар')
    externalHandler = () => Promise.reject(new TypeError('Failed to fetch'))
    renderScreen()

    const link = await screen.findByRole('link', { name: 'Додати вручну' })

    expect(link).toHaveAttribute(
      'href',
      '/catalog/new?mode=manual&title=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80',
    )
  })

  it('для ISBN-запиту посилання несе ISBN, а не назву', async () => {
    searchParams = new URLSearchParams(`q=${MANUAL_ISBN}`)
    lookupHandler = () => Promise.reject(new Error('немає'))
    renderScreen()

    expect(await screen.findByRole('link', { name: 'Додати вручну' })).toHaveAttribute(
      'href',
      `/catalog/new?mode=manual&isbn=${MANUAL_ISBN}&q=${MANUAL_ISBN}`,
    )
  })

  it('форма підхоплює відоме з адреси й додає книжку однією операцією; невідоме не надсилається', async () => {
    const user = userEvent.setup()

    renderScreen()

    expect(within(await manualField('Назва')).getByText('Нова книжка')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const calls = quickAddCalls() as unknown as {
      entryMethod: string
      target: Record<string, unknown>
    }[]

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      entryMethod: 'MANUAL',
      target: { kind: 'MANUAL', work: { title: 'Нова книжка' }, edition: { textKind: 'UNKNOWN' } },
    })
    expect(JSON.stringify(calls[0]?.target)).not.toMatch(/authors|isbn13|publisher|translation/)
    expect(push).toHaveBeenCalledWith('/library')
  })

  it('без назви — помилка поля, запиту немає', async () => {
    searchParams = new URLSearchParams('mode=manual')

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText('Вкажіть назву')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('помилковий ISBN — помилка поля, а не відмова сервера', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'ISBN-13')
    await user.type(screen.getByLabelText('ISBN-13'), '1234567890123')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/Некоректний ISBN-13/)).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('заповнена форма: автори, мова видання, «це оригінал», ISBN і видавництво — в одному запиті', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Автори')
    await user.type(screen.getByLabelText('Автор'), 'Тарас Шевченко')
    await user.click(screen.getByRole('button', { name: 'Додати автора' }))
    await user.type(screen.getByLabelText('Автор 2'), 'Співавтор')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Автори' }))
    await openManualEditor(user, 'Мова видання')
    await searchAndChooseOption(user, 'Мова видання', 'укр', 'українська')
    await openManualEditor(user, 'Це переклад?')
    await user.click(screen.getByLabelText('Ні — це оригінал'))
    await openManualEditor(user, 'ISBN-13')
    await user.type(screen.getByLabelText('ISBN-13'), '978-3-16-148410-0')
    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Видавництво')
    await user.type(screen.getByLabelText('Видавництво'), 'Наука')
    // The editors except the authors' stay open: «Додати до бібліотеки» takes what they hold.
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: {
        kind: 'MANUAL',
        work: {
          title: 'Нова книжка',
          authors: [{ name: 'Тарас Шевченко' }, { name: 'Співавтор' }],
        },
        edition: { textKind: 'ORIGINAL', lang: 'uk', isbn13: MANUAL_ISBN, publisher: 'Наука' },
      },
    })
  })

  it('«Це переклад? Так» відкриває необовʼязковий розділ; заповнений — іде в запит', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Це переклад?')
    await user.click(screen.getByLabelText('Так — це переклад'))
    await user.click(screen.getByText('Переклад (необов’язково)'))
    await openManualEditor(user, 'Перекладач')
    await user.type(screen.getByLabelText('Перекладач'), 'Олена Оніщук')
    await openManualEditor(user, 'Мова перекладу')
    await chooseOption(user, 'Мова перекладу', 'українська')
    await openManualEditor(user, 'З якої мови перекладено')
    await searchAndChooseOption(user, 'З якої мови перекладено', 'Англ', 'англійська')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: {
        edition: { textKind: 'TRANSLATION' },
        translation: { translator: 'Олена Оніщук', lang: 'uk', sourceLang: 'en' },
      },
    })
  })

  it('ISBN уже є в каталозі: пояснення й дія «Додати наявне видання» ведуть до EXISTING_EDITION', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(
            new ApiRequestError(409, {
              code: 'EDITION_ISBN_TAKEN',
              message: 'Видання з таким ISBN уже є в каталозі',
              details: { editionId: 'e-existing' },
            }),
          )
        : Promise.resolve(
            addedResponse(body as { operationId: string; target: { editionId: string } }),
          )
    }

    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'ISBN-13')
    await user.type(screen.getByLabelText('ISBN-13'), MANUAL_ISBN)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(
      await screen.findByText('Видання з таким ISBN уже є в каталозі BookSwap.'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати наявне видання' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
    expect(second).toMatchObject({ target: { kind: 'EXISTING_EDITION', editionId: 'e-existing' } })
  })

  it('невизначений результат: поля заблоковані, повтор — та сама операція з тим самим вмістом', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(
            addedResponse(body as { operationId: string; target: { editionId: string } }),
          )
    }

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/Не вдалося підтвердити додавання/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const [first, second] = quickAddCalls()

    expect(second).toEqual(first)
  })

  it('однозначна відмова: введене лишається, виправлена форма починає НОВУ операцію', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(
            new ApiRequestError(422, { code: 'VALIDATION_ERROR', message: 'Відхилено сервером' }),
          )
        : Promise.resolve(
            addedResponse(body as { operationId: string; target: { editionId: string } }),
          )
    }

    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Автори')
    await user.type(screen.getByLabelText('Автор'), 'Автор')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText('Відхилено сервером')).toBeInTheDocument()
    expect(within(await manualField('Автори')).getByText('Автор')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
  })

  it('після успіху «Додати ще одну книжку» дає порожню форму й новий намір', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await user.click(await screen.findByRole('button', { name: 'Додати ще одну книжку' }))

    expect(within(await manualField('Назва')).getByText('Нова книжка')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })

    expect(quickAddCalls()[0]?.operationId).not.toBe(quickAddCalls()[1]?.operationId)
  })

  it('наявний твір («Уточнити видання»): назва не редагується, у запиті лише workId', async () => {
    searchParams = new URLSearchParams('mode=manual&workId=w-77')
    mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path === '/works/w-77') {
        return Promise.resolve({
          work: { ...WORK, id: 'w-77', title: 'Наявний твір' },
          authors: AUTHORS,
          translations: [],
          editions: [],
        })
      }

      if (path === '/me/library/quick-add') return quickAddHandler(options?.body as QuickAddBody)

      return Promise.reject(new Error(`Неочікуваний запит ${path}`))
    })

    const user = userEvent.setup()

    renderScreen()

    expect(await screen.findByText('Наявний твір')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Назва' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: { kind: 'MANUAL', work: { workId: 'w-77' } },
    })
  })
})

describe('ручна форма: поля текстом, редактор на місці (BS-76)', () => {
  const ISBN = '9783161484100'
  const PREFILLED =
    'mode=manual&title=Кобзар&author=Тарас Шевченко&author=Друга Особа&isbn=9783161484100&firstPubYear=1840'

  beforeEach(() => {
    searchParams = new URLSearchParams('mode=manual')
    items = []
  })

  /**
   * BS-76 covers the book's data. «Ваш примірник» (BS-79) is the new copy's own setting, a plain selector
   * outside that rule — and exactly one control there.
   */
  function expectNoControls(): void {
    const copySection = screen.getByRole('region', { name: 'Ваш примірник' })

    for (const role of ['textbox', 'combobox', 'radio', 'spinbutton', 'checkbox'] as const) {
      expect(
        screen.queryAllByRole(role).filter((element) => !copySection.contains(element)),
      ).toHaveLength(0)
    }
    expect(within(copySection).getAllByRole('combobox')).toHaveLength(1)
  }

  /** The manual form alone never reads anything; only «Додати до бібліотеки» writes. */
  function expectNoRequests(): void {
    expect(mockApiRequest).not.toHaveBeenCalled()
  }

  it('порожня форма: назви полів текстом і «Додати», жодного поля вводу', async () => {
    renderScreen()
    await manualField('Назва')

    expectNoControls()
    // An empty field shows, in its value's place, a text action that names what it adds.
    for (const [field, action] of [
      ['Назва', 'Додати назву'],
      ['Автори', 'Додати автора'],
      ['Мова видання', 'Додати мову видання'],
      ['ISBN-13', 'Додати ISBN'],
    ] as const) {
      expect(within(await manualField(field)).getByRole('button', { name: action })).toBeVisible()
    }
    // The scanner (mocked here) sits in the ISBN row, beside «Додати ISBN».
    expect(
      within(await manualField('ISBN-13')).getByRole('button', { name: 'Simulate scan' }),
    ).toBeInTheDocument()
    // UNKNOWN is an answer, not an empty field: it reads «Не знаю», no open radio group.
    expect(within(await manualField('Це переклад?')).getByText('Не знаю')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Це переклад?' })).toBeInTheDocument()

    await userEvent.setup().click(screen.getByText('Додатково'))

    for (const action of [
      'Додати видавництво',
      'Додати рік видання',
      'Додати кількість сторінок',
      'Додати палітурку',
      'Додати посилання на обкладинку',
      'Додати рік першого видання',
    ]) {
      expect(screen.getByRole('button', { name: action })).toBeVisible()
    }
    expectNoControls()
    expectNoRequests()
  })

  it('передзаповнені з адреси назва, автори, ISBN і рік першого видання — текстом', async () => {
    searchParams = new URLSearchParams(PREFILLED)
    renderScreen()

    expect(within(await manualField('Назва')).getByText('Кобзар')).toBeInTheDocument()
    expect(
      within(await manualField('Автори'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Тарас Шевченко', 'Друга Особа'])
    expect(within(await manualField('ISBN-13')).getByText(ISBN)).toBeInTheDocument()
    expect(
      within(await manualField('Рік першого видання твору')).getByText('1840'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Автори' })).toBeInTheDocument()
    expectNoControls()
  })

  it('олівець і «Додати» відкривають саме свій контрол із фокусом і нічого не міняють', async () => {
    searchParams = new URLSearchParams(PREFILLED)

    const user = userEvent.setup()

    renderScreen()

    await openManualEditor(user, 'Назва')
    expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveValue('Кобзар')

    await openManualEditor(user, 'Автори')
    expect(screen.getByRole('textbox', { name: 'Автор' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Автор 2' })).toHaveValue('Друга Особа')

    await openManualEditor(user, 'Мова видання')
    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveFocus()

    await openManualEditor(user, 'Це переклад?')
    expect(screen.getByRole('radio', { name: 'Не знаю' })).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Не знаю' })).toBeChecked()

    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Палітурка')
    expect(screen.getByRole('combobox', { name: 'Палітурка' })).toHaveFocus()

    await openManualEditor(user, 'Рік видання')
    expect(screen.getByRole('textbox', { name: 'Рік видання' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Рік видання' })).toHaveValue('')
    expectNoRequests()
  })

  it('«Зберегти» біля поля повертає текст і фокус на олівець; запиту немає', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Назва')
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Кобзар')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Назва' }))

    expect(within(await manualField('Назва')).getByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: 'Назва' })).not.toBeInTheDocument()

    // An empty optional field confirms back to its «Додати», which gets the focus back.
    await openManualEditor(user, 'ISBN-13')
    await user.click(screen.getByRole('button', { name: 'Зберегти: ISBN-13' }))

    expect(screen.getByRole('button', { name: 'Додати ISBN' })).toHaveFocus()
    expect(quickAddCalls()).toHaveLength(0)
    expectNoRequests()
  })

  it('Enter в однорядковому полі підтверджує лише це поле, а не створює книжку', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Назва')
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Кобзар{Enter}')

    expect(within(await manualField('Назва')).getByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toHaveFocus()

    await openManualEditor(user, 'Автори')
    await user.type(screen.getByRole('textbox', { name: 'Автор' }), 'Тарас Шевченко{Enter}')

    expect(within(await manualField('Автори')).getByText('Тарас Шевченко')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
    expectNoRequests()
  })

  it('селектор мови: відкритий редактор фокусує його; Enter у пошуку вибирає мову, не підтверджуючи поле й не додаючи книжку (BS-92)', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Мова видання')

    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveFocus()

    await user.keyboard('{Enter}')
    await screen.findByRole('combobox', { name: 'Пошук: Мова видання' })
    await user.keyboard('  ЧЕС {Enter}')

    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('чеська')
    expect(screen.getByRole('button', { name: 'Зберегти: Мова видання' })).toBeInTheDocument()

    await user.keyboard('{Enter}')
    await screen.findByRole('combobox', { name: 'Пошук: Мова видання' })
    await user.keyboard('клінгонська{Enter}')

    expect(screen.getByRole('button', { name: 'Зберегти: Мова видання' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('чеська')

    await user.click(screen.getByRole('button', { name: 'Зберегти: Мова видання' }))

    expect(within(await manualField('Мова видання')).getByText('чеська')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
    expectNoRequests()
  })

  it('палітурка: «Скасувати» повертає «Не вказано», а «Зберегти» поля лише змінює чернетку (BS-92)', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Палітурка')
    await chooseOption(user, 'Палітурка', 'тверда')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Палітурка' }))

    expect(screen.getByRole('button', { name: 'Додати палітурку' })).toHaveFocus()

    await openManualEditor(user, 'Палітурка')
    await chooseOption(user, 'Палітурка', 'мʼяка')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Палітурка' }))

    expect(within(await manualField('Палітурка')).getByText('мʼяка')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('«Скасувати» повертає значення до відкриття редактора, не чіпаючи інших змін; фокус — на олівець', async () => {
    searchParams = new URLSearchParams(PREFILLED)

    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Мова видання')
    await chooseOption(user, 'Мова видання', 'українська')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Мова видання' }))

    await openManualEditor(user, 'Назва')
    await user.clear(screen.getByRole('textbox', { name: 'Назва' }))
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Інша')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Назва' }))

    expect(within(await manualField('Назва')).getByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toHaveFocus()
    expect(within(await manualField('Мова видання')).getByText('українська')).toBeInTheDocument()

    // An empty field cancelled after typing is empty again, its «Додати» focused.
    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Видавництво')
    await user.type(screen.getByRole('textbox', { name: 'Видавництво' }), 'Наука')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Видавництво' }))

    expect(screen.getByRole('button', { name: 'Додати видавництво' })).toHaveFocus()
    expect(quickAddCalls()).toHaveLength(0)
    expectNoRequests()
  })

  it('перехід з поля нічого не зберігає й не скасовує: редактор лишається з введеним', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Назва')
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Кобзар')
    await user.click(screen.getByRole('heading', { name: 'Додати книжку вручну' }))
    await user.tab()

    expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveValue('Кобзар')
  })

  it('автори: «Скасувати» після зміни лише імені повертає попереднє імʼя', async () => {
    searchParams = new URLSearchParams(PREFILLED)

    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Автори')
    await user.clear(screen.getByRole('textbox', { name: 'Автор' }))
    await user.type(screen.getByRole('textbox', { name: 'Автор' }), 'Інше Імʼя')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

    expect(
      within(await manualField('Автори'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Тарас Шевченко', 'Друга Особа'])
    expect(screen.getByRole('button', { name: 'Редагувати: Автори' })).toHaveFocus()
  })

  it('автори: «Скасувати» після додавання й видалення рядків відновлює весь попередній список', async () => {
    searchParams = new URLSearchParams(PREFILLED)

    const user = userEvent.setup()

    renderScreen()

    // Twice: the second cancel proves the first one's restored list is still independent of the edits.
    for (let round = 0; round < 2; round += 1) {
      await openManualEditor(user, 'Автори')
      await user.click(screen.getByRole('button', { name: 'Прибрати автора 1' }))
      await user.click(screen.getByRole('button', { name: 'Додати автора' }))
      await user.type(screen.getByRole('textbox', { name: 'Автор 2' }), 'Третя')
      await user.clear(screen.getByRole('textbox', { name: 'Автор' }))
      await user.type(screen.getByRole('textbox', { name: 'Автор' }), 'Змінена')
      await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

      expect(
        within(await manualField('Автори'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Тарас Шевченко', 'Друга Особа'])
    }

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: { work: { authors: [{ name: 'Тарас Шевченко' }, { name: 'Друга Особа' }] } },
    })
  })

  it('автори: ліміт рядків чинний — після десятого «Додати автора» в редакторі немає', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Автори')

    for (let row = 1; row < 10; row += 1) {
      await user.click(screen.getByRole('button', { name: 'Додати автора' }))
    }

    expect(screen.getAllByRole('textbox', { name: /^Автор/ })).toHaveLength(10)
    expect(screen.queryByRole('button', { name: 'Додати автора' })).not.toBeInTheDocument()
  })

  it('лише назва: мінімальний payload, як і до BS-76', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Назва')
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Кобзар')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Назва' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    const calls = quickAddCalls() as unknown as { entryMethod: string; target: unknown }[]

    expect(calls).toHaveLength(1)
    expect(calls[0]?.entryMethod).toBe('MANUAL')
    expect(calls[0]?.target).toEqual({
      kind: 'MANUAL',
      work: { title: 'Кобзар' },
      edition: { textKind: 'UNKNOWN' },
    })
  })

  it('загальне додавання враховує відкриті редактори й закриває їх', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Назва')
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Кобзар')
    await openManualEditor(user, 'ISBN-13')
    await user.type(screen.getByRole('textbox', { name: 'ISBN-13' }), ISBN)
    quickAddHandler = () => new Promise(() => undefined)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByRole('button', { name: 'Додаю…' })).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).toMatchObject({
      target: { work: { title: 'Кобзар' }, edition: { isbn13: ISBN } },
    })
    expectNoControls()
  })

  it('невалідне значення: «Зберегти» біля поля лишає редактор відкритим з доступною помилкою й фокусом', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'ISBN-13')
    await user.type(screen.getByRole('textbox', { name: 'ISBN-13' }), '1234567890123')
    await user.click(screen.getByRole('button', { name: 'Зберегти: ISBN-13' }))

    const isbn = screen.getByRole('textbox', { name: 'ISBN-13' })

    expect(isbn).toHaveFocus()
    expect(isbn).toHaveAttribute('aria-invalid', 'true')
    expect(isbn).toHaveAccessibleDescription(expect.stringContaining('Некоректний ISBN-13'))
    expect(screen.getByRole('alert')).toHaveTextContent(/Некоректний ISBN-13/)
    expect(quickAddCalls()).toHaveLength(0)

    // «Скасувати» drops the invalid value and its error together.
    await user.click(screen.getByRole('button', { name: 'Скасувати: ISBN-13' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати ISBN' })).toHaveFocus()
  })

  it('підтвердження необовʼязкового поля не вимагає спершу назви', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Рік видання')
    await user.type(screen.getByRole('textbox', { name: 'Рік видання' }), '20x0')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Рік видання' }))

    expect(screen.getByText('Потрібне ціле число')).toBeInTheDocument()

    await user.clear(screen.getByRole('textbox', { name: 'Рік видання' }))
    await user.type(screen.getByRole('textbox', { name: 'Рік видання' }), '2020')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Рік видання' }))

    expect(within(await manualField('Рік видання')).getByText('2020')).toBeInTheDocument()
    expect(screen.queryByText('Вкажіть назву')).not.toBeInTheDocument()
  })

  it('без назви «Додати до бібліотеки» відкриває редактор назви з помилкою й фокусом', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    const title = screen.getByRole('textbox', { name: 'Назва' })

    expect(title).toHaveFocus()
    expect(title).toHaveAccessibleDescription('Вкажіть назву')
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('помилка в згорнутому «Додатково» відкриває розділ і поле з помилкою', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Кобзар&firstPubYear=184x')

    const user = userEvent.setup()

    renderScreen()
    await manualField('Назва')

    expect(screen.getByText('Додатково').closest('details')).not.toHaveAttribute('open')

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    const year = screen.getByRole('textbox', { name: 'Рік першого видання твору' })

    expect(screen.getByText('Додатково').closest('details')).toHaveAttribute('open')
    expect(year).toBeVisible()
    expect(year).toHaveFocus()
    expect(year).toHaveAccessibleDescription('Потрібне ціле число')
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('помилка в згорнутому розділі перекладу відкриває розділ і поле перекладача', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Кобзар')

    const user = userEvent.setup()

    renderScreen()
    await openManualEditor(user, 'Це переклад?')
    await user.click(screen.getByRole('radio', { name: 'Так — це переклад' }))
    await user.click(screen.getByRole('button', { name: 'Зберегти: Це переклад?' }))

    expect(
      within(await manualField('Це переклад?')).getByText('Так — це переклад'),
    ).toBeInTheDocument()

    const summary = screen.getByText('Переклад (необов’язково)')

    await user.click(summary)
    await openManualEditor(user, 'З якої мови перекладено')
    await chooseOption(user, 'З якої мови перекладено', 'англійська')
    // The source language alone is fine for ITS editor; the missing translator is not its error.
    await user.click(screen.getByRole('button', { name: 'Зберегти: З якої мови перекладено' }))

    expect(
      within(await manualField('З якої мови перекладено')).getByText('англійська'),
    ).toBeInTheDocument()

    await user.click(summary)
    expect(summary.closest('details')).not.toHaveAttribute('open')

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    const translator = screen.getByRole('textbox', { name: 'Перекладач' })

    expect(summary.closest('details')).toHaveAttribute('open')
    expect(translator).toHaveFocus()
    expect(translator).toHaveAttribute('aria-invalid', 'true')
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('поки додавання триває: поля не відкриваються, повторного запиту немає', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Кобзар')
    quickAddHandler = () => new Promise(() => undefined)

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByRole('button', { name: 'Додаю…' })

    expect(screen.getByRole('button', { name: 'Редагувати: Назва' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Додати автора' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Додаю…' }))

    expect(quickAddCalls()).toHaveLength(1)
  })

  it('сканер ISBN доступний у ручній формі й лише підставляє ISBN у чернетку', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Кобзар')

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))

    expect(within(await manualField('ISBN-13')).getByText(ISBN)).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({ target: { edition: { isbn13: ISBN } } })
  })

  it('наявний твір: назва фіксована, полів автора й року першого видання немає', async () => {
    searchParams = new URLSearchParams('mode=manual&workId=w-77')
    mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
      if (path === '/works/w-77') {
        return Promise.resolve({
          work: { ...WORK, id: 'w-77', title: 'Наявний твір' },
          authors: AUTHORS,
          translations: [],
          editions: [],
        })
      }

      if (path === '/me/library/quick-add') return quickAddHandler(options?.body as QuickAddBody)

      return Promise.reject(new Error(`Неочікуваний запит ${path}`))
    })

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Наявний твір')
    await user.click(screen.getByText('Додатково'))

    expect(screen.queryByRole('group', { name: 'Автори' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Рік першого видання твору' }),
    ).not.toBeInTheDocument()
    expect(await manualField('Видавництво')).toBeInTheDocument()

    await openManualEditor(user, 'Видавництво')
    await user.type(screen.getByRole('textbox', { name: 'Видавництво' }), 'Наука')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: { work: { workId: 'w-77' }, edition: { publisher: 'Наука' } },
    })
    expect(JSON.stringify(quickAddCalls()[0])).not.toMatch(/authors|title/)
  })
})

describe('твір без видання та запис про твір: «Уточнити дані»', () => {
  it('твір нашого каталогу веде в ручну форму з цим твором', async () => {
    searchParams = new URLSearchParams('q=абстрактний')
    items = [
      {
        kind: 'WORK',
        key: 'work:w-9',
        work: { ...WORK, id: 'w-9', title: 'Абстрактний твір' },
        authors: [],
        matchedOn: 'TITLE',
      },
    ]
    renderScreen()

    const dialog = await openCard(userEvent.setup())

    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toHaveAttribute(
      'href',
      `/catalog/new?mode=manual&workId=w-9&${new URLSearchParams({ q: 'абстрактний' }).toString()}`,
    )
  })

  it('зовнішній запис про твір — та сама форма з відомими даними, без вигаданого ISBN чи обкладинки', async () => {
    searchParams = new URLSearchParams('q=твір')
    items = []
    externalItems = [
      {
        kind: 'EXTERNAL',
        key: 'external:OPEN_LIBRARY:OL1W',
        result: {
          id: 'OPEN_LIBRARY:OL1W',
          kind: 'WORK',
          sources: ['OPEN_LIBRARY'],
          title: 'Запис про твір',
          authors: ['Автор Один', 'Автор Два'],
          firstPublishedYear: 1937,
        },
      },
    ]
    renderScreen()

    const dialog = await openCard(userEvent.setup())
    const href = within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href')
    const parameters = new URLSearchParams(href?.split('?')[1])

    expect(parameters.get('mode')).toBe('manual')
    expect(parameters.get('title')).toBe('Запис про твір')
    expect(parameters.getAll('author')).toEqual(['Автор Один', 'Автор Два'])
    expect(parameters.get('firstPubYear')).toBe('1937')
    expect(parameters.has('isbn')).toBe(false)
    expect(parameters.get('q')).toBe('твір')
  })
})

describe('«← До пошуку» повертає до того самого пошуку (BS-126)', () => {
  const INPUT = 'Назва, автор або ISBN'
  const ISBN = '9783161484100'

  function hrefOf(name: string | RegExp): string {
    return screen.getByRole('link', { name }).getAttribute('href') ?? ''
  }

  function searchRequests(): string[] {
    return mockApiRequest.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith('/me/library/add-search?'))
  }

  it('текстовий запит: поле, сторінка й розмір відновлюються, редагування назви запиту не міняє', async () => {
    searchParams = new URLSearchParams('q=кобзар&page=2&pageSize=24')

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Кобзар')
    act(() => {
      navigate(hrefOf('Додати вручну'))
    })

    expect(within(await manualField('Назва')).getByText('кобзар')).toBeInTheDocument()

    await openManualEditor(user, 'Назва')

    const title = screen.getByLabelText('Назва')

    expect(title).toHaveValue('кобзар')
    await user.clear(title)
    await user.type(title, 'Інша назва')

    mockApiRequest.mockClear()
    act(() => {
      navigate(hrefOf('← До пошуку'))
    })

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByLabelText(INPUT)).toHaveValue('кобзар')
    expect(searchRequests()).toEqual([
      '/me/library/add-search?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2&pageSize=24',
    ])
  })

  it('ISBN: повертає до пошуку за ISBN, а не до порожнього поля', async () => {
    searchParams = new URLSearchParams(`q=${ISBN}`)
    lookupHandler = () => Promise.reject(new Error('немає'))
    renderScreen()
    await screen.findByText('Кобзар')
    act(() => {
      navigate(hrefOf('Додати вручну'))
    })

    expect(within(await manualField('ISBN-13')).getByText(ISBN)).toBeInTheDocument()

    mockApiRequest.mockClear()
    act(() => {
      navigate(hrefOf('← До пошуку'))
    })

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByLabelText(INPUT)).toHaveValue(ISBN)
    expect(searchRequests()).toEqual([`/me/library/add-search?q=${ISBN}&page=1&pageSize=12`])
  })

  it('«Уточнити дані» теж несе пошук туди й назад', async () => {
    const work = { ...WORK, id: 'w-9', title: 'Абстрактний твір' }
    const searching = mockApiRequest.getMockImplementation()

    searchParams = new URLSearchParams('q=абстрактний')
    items = [{ kind: 'WORK', key: 'work:w-9', work, authors: [], matchedOn: 'TITLE' }]
    mockApiRequest.mockImplementation((path: string, options?: unknown) =>
      path === '/works/w-9'
        ? Promise.resolve({ work, authors: [], translations: [], editions: [] })
        : searching?.(path, options),
    )
    renderScreen()
    await openCard(userEvent.setup())
    act(() => {
      navigate(hrefOf('Уточнити дані'))
    })
    await screen.findByRole('heading', { name: 'Додати книжку вручну' })

    expect(hrefOf('← До пошуку')).toBe(
      `/catalog/new?${new URLSearchParams({ q: 'абстрактний' }).toString()}`,
    )
  })

  it('після перезавантаження форми повернення бере пошук з адреси', async () => {
    searchParams = new URLSearchParams('mode=manual&title=кобзар&q=кобзар&page=3&pageSize=24')
    renderScreen()

    expect(within(await manualField('Назва')).getByText('кобзар')).toBeInTheDocument()
    expect(hrefOf('← До пошуку')).toBe(
      `/catalog/new?${new URLSearchParams({ q: 'кобзар', page: '3', pageSize: '24' }).toString()}`,
    )
  })

  it('стара форма з автопідказок (auto=1) повертає до повного пошуку того самого тексту', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Кобз&q=Кобз&auto=1')
    renderScreen()
    await manualField('Назва')

    act(() => {
      navigate(hrefOf('← До пошуку'))
    })

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByLabelText(INPUT)).toHaveValue('Кобз')
    // The old flag is dropped from the address (the form's already); what is shown is the full search.
    expect(searchParams.has('auto')).toBe(false)
    expect(searchRequests()).toEqual([
      `/me/library/add-search?q=${encodeURIComponent('Кобз')}&page=1&pageSize=12`,
    ])
  })

  it('пряме відкриття форми: повернення до порожнього пошуку без запитів', async () => {
    searchParams = new URLSearchParams('mode=manual')
    renderScreen()
    await manualField('Назва')

    expect(hrefOf('← До пошуку')).toBe('/catalog/new?q=')

    act(() => {
      navigate(hrefOf('← До пошуку'))
    })

    expect(await screen.findByLabelText(INPUT)).toHaveValue('')
    expect(searchRequests()).toEqual([])
  })
})

describe('пошук під час введення: одразу повний пошук (BS-134)', () => {
  const INPUT = 'Назва, автор або ISBN'

  /** Шляхи всіх запитів за префіксом: рахуємо те, що справді пішло на сервер. */
  function requested(prefix: string): string[] {
    return mockApiRequest.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith(prefix))
  }

  const fullLocal = () => requested('/me/library/add-search?')
  const fullExternal = () => requested('/me/library/add-search/external?')
  const suggestions = () => requested('/me/library/add-search/suggest')
  /** Requests carry the page size as is — 12 when the address names none (`DEFAULT_SEARCH_PAGE_SIZE`). */
  const localUrl = (q: string, page = 1, pageSize = 12) =>
    `/me/library/add-search?q=${encodeURIComponent(q)}&page=${String(page)}&pageSize=${String(pageSize)}`
  const externalUrl = (q: string, page = 1, pageSize = 12) =>
    `/me/library/add-search/external?q=${encodeURIComponent(q)}&page=${String(page)}&pageSize=${String(pageSize)}`
  const searchUrl = (q: string, extra: Record<string, string> = {}) =>
    `/catalog/new?${new URLSearchParams({ q, ...extra }).toString()}`

  const advance = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }

  function setup() {
    return userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  }

  const externalAnswer = (extra: Record<string, unknown> = {}) => ({
    items: externalItems,
    sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
    page: 1,
    pageSize: 10,
    more: 'NO',
    complete: true,
    ...extra,
  })

  beforeEach(() => {
    jest.useFakeTimers()
    searchParams = new URLSearchParams()
    items = [editionItem('e-1')]
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('від 2 символів через 350 мс: повний пошук першої сторінки, адреса — replace без auto й без прокручування', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')

    expect(fullLocal()).toHaveLength(0)
    await advance(349)
    expect(fullLocal()).toHaveLength(0)
    await advance(1)

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(fullLocal()).toEqual([localUrl('Ко')])
    expect(replace).toHaveBeenCalledWith(searchUrl('Ко'), { scroll: false })
    expect(push).not.toHaveBeenCalled()
    expect(suggestions()).toHaveLength(0)
    expect(
      screen.queryByRole('button', { name: 'Показати всі результати' }),
    ).not.toBeInTheDocument()
    // The page size is there at once: it is a choice even when the results fit on one page.
    expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toBeInTheDocument()
  })

  it('1 символ нічого не шукає, а 2 символи не питають зовнішні джерела', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'К')
    await advance(10_000)
    expect(fullLocal()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(INPUT), 'о')
    await advance(10_000)
    expect(fullLocal()).toHaveLength(1)
    expect(fullExternal()).toHaveLength(0)
  })

  it('від 3 символів зовнішня половина того самого пошуку — через 900 мс після ОСТАННЬОЇ зміни', async () => {
    externalItems = [externalEdition('vol-1', { isbn13: '9783161484100' })]

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобз')
    await advance(350)
    expect(fullLocal()).toEqual([localUrl('Кобз')])
    // The local half is shown; the external one is still "searching", not "nothing".
    expect(screen.getByText('Шукаю…')).toBeInTheDocument()
    await advance(548)
    expect(fullExternal()).toHaveLength(0)
    await advance(2)

    expect(await screen.findByText('Зовнішня vol-1')).toBeInTheDocument()
    expect(fullExternal()).toEqual([externalUrl('Кобз')])
    expect(suggestions()).toHaveLength(0)
  })

  it('швидкий набір слова — один запит на кожну половину', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(5_000)

    expect(fullLocal()).toEqual([localUrl('Кобзар')])
    expect(fullExternal()).toEqual([externalUrl('Кобзар')])
  })

  it('неповна зовнішня сторінка (complete=false) довантажується тим самим запитом, і лише тоді вона кінцева', async () => {
    items = []
    externalItems = [externalEdition('vol-1')]

    let asked = 0

    externalHandler = () => {
      asked += 1

      return Promise.resolve(
        asked === 1
          ? externalAnswer({ items: [], more: 'UNKNOWN', complete: false })
          : externalAnswer(),
      )
    }

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(5_000)

    expect(await screen.findByText('Зовнішня vol-1')).toBeInTheDocument()
    expect(fullExternal()).toEqual([externalUrl('Кобзар'), externalUrl('Кобзар')])
    expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()
  })

  it('Enter до завершення таймерів: рівно один повний пошук, обидві половини одразу', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(200)
    await user.keyboard('{Enter}')
    await advance(10_000)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith(searchUrl('Кобзар'))
    expect(replace).not.toHaveBeenCalled()
    expect(fullLocal()).toHaveLength(1)
    expect(fullExternal()).toHaveLength(1)
  })

  it('Enter на явно двосимвольному запиті питає й зовнішні джерела', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко{Enter}')
    await advance(10_000)

    expect(fullLocal()).toEqual([localUrl('Ко')])
    expect(fullExternal()).toEqual([externalUrl('Ко')])
  })

  it('Enter на щойно знайденому тексті шукає знову: повторний пошук незміненого запиту', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(5_000)
    await user.keyboard('{Enter}')
    await advance(5_000)

    expect(fullLocal()).toEqual([localUrl('Кобзар'), localUrl('Кобзар')])
    expect(fullExternal()).toEqual([externalUrl('Кобзар'), externalUrl('Кобзар')])
  })

  it('старі відповіді не підміняють нові', async () => {
    const pending = new Map<string, (value: unknown) => void>()

    localHandler = (query) =>
      new Promise((resolve) => {
        pending.set(query, resolve)
      })

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await user.type(screen.getByLabelText(INPUT), 'б')
    await advance(350)

    expect([...pending.keys()]).toEqual(['Ко', 'Коб'])

    const named = (title: string) =>
      searchResponse([editionItem('e-1', { work: { ...WORK, title } })])

    await act(async () => {
      pending.get('Коб')?.(named('Нова відповідь'))
    })
    await act(async () => {
      pending.get('Ко')?.(named('Стара відповідь'))
    })

    expect(await screen.findByText('Нова відповідь')).toBeInTheDocument()
    expect(screen.queryByText('Стара відповідь')).not.toBeInTheDocument()
  })

  it('поки йде новий набраний запит, попередній список лишається без пагінації, а «нічого не знайдено» не з’являється', async () => {
    const pending = new Map<string, (value: unknown) => void>()

    localHandler = (query) =>
      query === 'Ко'
        ? Promise.resolve(searchResponse(items, { hasMore: true }))
        : new Promise((resolve) => {
            pending.set(query, resolve)
          })

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    expect(await screen.findByText('Кобзар')).toBeInTheDocument()

    await user.type(screen.getByLabelText(INPUT), 'б')
    await advance(350)

    expect(screen.getByText('Кобзар')).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого/)).not.toBeInTheDocument()
    expect(screen.getByText('Шукаю…')).toBeInTheDocument()
    // The kept list belongs to «Ко»: its pages are not offered under «Коб».
    expect(
      screen.queryByRole('navigation', { name: 'Сторінки результатів' }),
    ).not.toBeInTheDocument()
  })

  it('очищення поля прибирає набраний пошук і скасовує очікуване', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(350)
    await screen.findByText('Кобзар')

    await user.clear(screen.getByLabelText(INPUT))
    await advance(10_000)

    expect(replace).toHaveBeenLastCalledWith('/catalog/new', { scroll: false })
    expect(screen.queryByText('Кобзар')).not.toBeInTheDocument()
    expect(fullExternal()).toHaveLength(0)
  })

  it('очищення поля після явного пошуку результатів не прибирає', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар' })

    const user = setup()

    renderScreen()
    await screen.findByText('Кобзар')
    await user.clear(screen.getByLabelText(INPUT))
    await advance(10_000)

    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText('Кобзар')).toBeInTheDocument()
  })

  it('IME: під час композиції запитів немає, після compositionend — шукається завершений текст', async () => {
    renderScreen()

    const input = screen.getByLabelText(INPUT)

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'ко' } })
    fireEvent.change(input, { target: { value: 'коб' } })
    await advance(10_000)
    expect(fullLocal()).toHaveLength(0)
    expect(fullExternal()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'кобзар' } })
    fireEvent.compositionEnd(input)
    await advance(350)

    expect(fullLocal()).toEqual([localUrl('кобзар')])
    expect(fullExternal()).toHaveLength(0)

    await advance(550)
    expect(fullExternal()).toEqual([externalUrl('кобзар')])
  })

  it('зміна лише пробілів не запускає нового пошуку; адреса несе нормалізований текст', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), '  Кобзар  ')
    await advance(5_000)
    expect(fullLocal()).toEqual([localUrl('Кобзар')])
    expect(replace).toHaveBeenCalledWith(searchUrl('Кобзар'), { scroll: false })

    await user.type(screen.getByLabelText(INPUT), '   ')
    await advance(5_000)
    await user.type(screen.getByLabelText(INPUT), '{Backspace}{Backspace}{Backspace}')
    await advance(5_000)

    expect(fullLocal()).toHaveLength(1)
    expect(fullExternal()).toHaveLength(1)
  })

  it('валідний ISBN: точний сценарій без очікування, жодного текстового зовнішнього пошуку', async () => {
    lookupHandler = () => Promise.resolve({ result: { title: 'Знайдена за ISBN' } })

    const user = setup()

    renderScreen()
    await user.click(screen.getByLabelText(INPUT))
    await user.paste('9783161484100')
    await advance(0)

    expect(replace).toHaveBeenCalledWith('/catalog/new?q=9783161484100', { scroll: false })
    expect(fullLocal()).toHaveLength(1)
    expect(requested('/catalog/lookup?')).toHaveLength(1)

    await advance(10_000)
    expect(fullExternal()).toHaveLength(0)
    expect(suggestions()).toHaveLength(0)
  })

  it('«1984» шукається як назва, а не як ISBN', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), '1984')
    await advance(350)

    expect(fullLocal()).toEqual([localUrl('1984')])
    expect(requested('/catalog/lookup?')).toHaveLength(0)
  })

  describe('недоступність зовнішнього джерела', () => {
    it('429 від зовнішньої половини: один запит без циклу повторів, місцеві результати й ручне додавання на місці', async () => {
      externalHandler = () =>
        Promise.reject(
          new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
        )

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(900)

      expect(await screen.findByText('Кобзар')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Додати вручну' })).toBeInTheDocument()
      expect(screen.queryByText('Шукаю…')).not.toBeInTheDocument()

      await advance(120_000)
      expect(fullExternal()).toHaveLength(1)
    })

    it('джерело відповіло RATE_LIMITED/TIMEOUT: не «нічого не знайдено», а «не відповіли»', async () => {
      items = []
      externalHandler = () =>
        Promise.resolve(
          externalAnswer({
            items: [],
            sources: [{ source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' }],
            more: 'UNKNOWN',
          }),
        )

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(900)

      expect(await screen.findByText(/чи є там ця книжка, невідомо/)).toBeInTheDocument()
      expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()
      // No source answered: the pages ahead are not asked of them (`UNKNOWN` still offers «Далі»).
      await advance(10_000)
      expect(fullExternal()).toHaveLength(1)
      expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toBeInTheDocument()
    })

    it('підтверджена порожня відповідь — «нічого не знайшлося», але лише коли обидві половини завершені', async () => {
      items = []
      externalItems = []

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(350)
      // The local answer is in, the external one is not even asked yet: "none" is not said.
      expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()

      await advance(600)
      expect(await screen.findByText('Нічого схожого не знайшлося.')).toBeInTheDocument()
    })

    it('набрані два символи без зовнішніх джерел: підказка натиснути «Шукати»', async () => {
      items = []

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Ко')
      await advance(5_000)

      expect(await screen.findByText(/Додайте символ або натисніть «Шукати»/)).toBeInTheDocument()
    })
  })

  it('додавання з набраного пошуку: «Додаю…» → «✓ У моїй бібліотеці»; запит, список і адреса не змінюються', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await screen.findByText('Кобзар')
    await addFromCard(user)
    await advance(0)

    expect(await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).toMatchObject({
      target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
    })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it('повтор після невизначеного результату йде тією самою операцією', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(addedResponse(body))
    }

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await screen.findByText('Кобзар')
    await addFromCard(user)
    expect(await screen.findByText(/Не вдалося підтвердити додавання/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [first, second] = quickAddCalls()

    expect(second).toEqual(first)
  })

  it('«ще один примірник» з набраного пошуку — нова операція', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 1, archivedCount: 0 } })]

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await screen.findByText('Кобзар')

    const dialog = await openCard(user)

    await user.click(within(dialog).getByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })
    await user.click(
      await within(dialog).findByRole('button', { name: 'Додати ще один примірник' }),
    )

    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })
    expect(quickAddCalls()[0]?.operationId).not.toBe(quickAddCalls()[1]?.operationId)
  })

  it('твір без видання з набраного пошуку веде в уточнення, а не додається', async () => {
    items = [
      {
        kind: 'WORK',
        key: 'work:w-9',
        work: { ...WORK, id: 'w-9', title: 'Абстрактний твір' },
        authors: [],
        matchedOn: 'TITLE',
      },
    ]

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Аб')
    await advance(350)

    expect(await screen.findByText('Абстрактний твір')).toBeInTheDocument()

    const dialog = await openCard(user)

    expect(within(dialog).queryByRole('button', { name: /Додати/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()
  })

  describe('підказка виправлення написання', () => {
    const TYPO = 'Гарі Потер'
    const FIXED = 'Гаррі Поттер'
    const hintFor = (forQuery: string) => ({
      spellingSuggestion: { forQuery, text: FIXED },
    })
    const hintText = () => screen.queryByText(/Можливо, ви шукали/)
    /** Зовнішня половина повного пошуку з тим самим рішенням, що й локальна (так відповідає сервер). */
    const externalWithHint = () =>
      Promise.resolve({
        items: [],
        sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        page: 1,
        pageSize: 10,
        more: 'NO',
        complete: true,
        ...hintFor(TYPO),
      })

    it('помилка в написанні → рядок під полем із кнопкою-посиланням; запит у полі не змінюється', async () => {
      fullExtra = hintFor(TYPO)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
      expect(hintText()).toHaveTextContent(`Можливо, ви шукали «${FIXED}»?`)
      expect(screen.getByLabelText(INPUT)).toHaveValue(TYPO)
      // Без картки й модального вікна: звичайний рядок тексту.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('правильний запит: сервер підказки не дав — рядка немає', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(350)
      await screen.findByText('Кобзар')

      expect(hintText()).not.toBeInTheDocument()
    })

    it('підказка є і в повному пошуку з адреси (q)', async () => {
      searchParams = new URLSearchParams({ q: TYPO })
      fullExtra = hintFor(TYPO)
      externalHandler = externalWithHint

      renderScreen()

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зміна тексту прибирає стару підказку негайно, не чекаючи нової відповіді', async () => {
      localHandler = (query) =>
        query === TYPO
          ? Promise.resolve(searchResponse(items, hintFor(TYPO)))
          : new Promise(() => undefined)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await screen.findByRole('button', { name: FIXED })

      await user.type(screen.getByLabelText(INPUT), 'а')

      expect(hintText()).not.toBeInTheDocument()

      // Повернення до того самого тексту підказку не воскрешає без відповіді сервера на нього.
      await advance(10_000)
      expect(hintText()).not.toBeInTheDocument()
    })

    it('очищення поля прибирає підказку', async () => {
      fullExtra = hintFor(TYPO)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await screen.findByRole('button', { name: FIXED })

      await user.clear(screen.getByLabelText(INPUT))

      expect(hintText()).not.toBeInTheDocument()
    })

    it('запізніла відповідь на старий текст не показує виправлення для нового', async () => {
      let release: (value: unknown) => void = () => undefined

      localHandler = (query) =>
        query === TYPO
          ? new Promise((resolve) => {
              release = resolve
            })
          : Promise.resolve(searchResponse(items))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await user.type(screen.getByLabelText(INPUT), 'а')
      release(searchResponse(items, hintFor(TYPO)))
      await advance(10_000)

      expect(hintText()).not.toBeInTheDocument()
    })

    it('натискання: поле отримує виправлене написання, одна навігація й один повний пошук виправленого запиту', async () => {
      fullExtra = hintFor(TYPO)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(10_000)

      expect(screen.getByLabelText(INPUT)).toHaveValue(FIXED)
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith(searchUrl(FIXED))
      // The typed search that showed the hint, then exactly one search of the fix.
      expect(fullLocal()).toEqual([localUrl(TYPO), localUrl(FIXED)])
      // The typo's external half was never asked: the click came before its pause.
      expect(fullExternal()).toEqual([externalUrl(FIXED)])
      expect(replace).toHaveBeenCalledTimes(1)
    })

    it('натискання скидає сторінку результатів на першу', async () => {
      searchParams = new URLSearchParams({ q: TYPO, page: '3', pageSize: '24' })
      fullExtra = hintFor(TYPO)
      externalHandler = externalWithHint

      const user = setup()

      renderScreen()
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(0)

      expect(push).toHaveBeenCalledTimes(1)
      // Page 1 again; an explicit non-default size is kept.
      expect(push).toHaveBeenCalledWith(searchUrl(FIXED, { pageSize: '24' }))
    })

    it('кнопка доступна з клавіатури: Tab доходить до неї, Enter запускає один пошук', async () => {
      fullExtra = hintFor(TYPO)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)

      const button = await screen.findByRole('button', { name: FIXED })

      for (let step = 0; step < 8 && document.activeElement !== button; step += 1) {
        await user.tab()
      }

      expect(button).toHaveFocus()
      expect(button).toHaveAttribute('type', 'button')

      await user.keyboard('{Enter}')
      await advance(10_000)

      expect(push).toHaveBeenCalledTimes(1)
      expect(fullLocal()).toEqual([localUrl(TYPO), localUrl(FIXED)])
    })
  })

  describe('підказка виправлення з зовнішніх джерел', () => {
    const TYPO = 'Гарі Потер'
    const FIXED = 'Гаррі Поттер'
    const suggestion = { forQuery: TYPO, text: FIXED }
    const answer = (extra: Record<string, unknown> = {}, sources = 1) => ({
      items: [],
      sources: Array.from({ length: sources }, () => ({ source: 'GOOGLE_BOOKS', status: 'OK' })),
      page: 1,
      pageSize: 10,
      more: 'NO',
      complete: true,
      ...extra,
    })
    const hintText = () => screen.queryByText(/Можливо, ви шукали/)

    beforeEach(() => {
      // Наш каталог порожній: підказка може прийти лише від джерел.
      items = []
    })

    it('наш каталог порожній, джерело знає правильну назву → підказка з’являється після зовнішньої відповіді', async () => {
      externalHandler = () => Promise.resolve(answer({ spellingSuggestion: suggestion }))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      expect(hintText()).not.toBeInTheDocument()

      await advance(550)

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
      expect(screen.getByLabelText(INPUT)).toHaveValue(TYPO)
      // No request beyond the search itself: one per half.
      expect(fullLocal()).toHaveLength(1)
      expect(fullExternal()).toHaveLength(1)
    })

    it('повний пошук з адреси: підказка зовнішньої половини теж під полем', async () => {
      searchParams = new URLSearchParams({ q: TYPO })
      externalHandler = () => Promise.resolve(answer({ spellingSuggestion: suggestion }))

      renderScreen()

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зовнішня відповідь мовчить (кандидати суперечать) — локальна підказка зникає', async () => {
      fullExtra = { spellingSuggestion: suggestion }
      externalHandler = () => Promise.resolve(answer())

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)

      // Поки джерела мовчать, діє локальна.
      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()

      await advance(550)

      await waitFor(() => {
        expect(hintText()).not.toBeInTheDocument()
      })
    })

    it('джерела не питали (sources порожній): локальна підказка лишається', async () => {
      fullExtra = { spellingSuggestion: suggestion }
      externalHandler = () => Promise.resolve(answer({}, 0))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(5_000)

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зміна тексту прибирає підказку з джерела негайно', async () => {
      externalHandler = (query) =>
        query === TYPO
          ? Promise.resolve(answer({ spellingSuggestion: suggestion }))
          : new Promise(() => undefined)

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(900)
      await screen.findByRole('button', { name: FIXED })

      await user.type(screen.getByLabelText(INPUT), 'а')

      expect(hintText()).not.toBeInTheDocument()
    })

    it('запізніла відповідь джерела на старий текст не виправляє новий', async () => {
      let release: (value: unknown) => void = () => undefined

      externalHandler = (query) =>
        query === TYPO
          ? new Promise((resolve) => {
              release = resolve
            })
          : Promise.resolve(answer())

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(900)
      await user.type(screen.getByLabelText(INPUT), 'а')
      release(answer({ spellingSuggestion: suggestion }))
      await advance(10_000)

      expect(hintText()).not.toBeInTheDocument()
    })

    it('натискання на підказку з джерела: одна навігація, один повний пошук за виправленим запитом зі сторінки 1', async () => {
      searchParams = new URLSearchParams({ q: TYPO, page: '2', pageSize: '24' })
      externalHandler = () => Promise.resolve(answer({ spellingSuggestion: suggestion }))

      const user = setup()

      renderScreen()
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(10_000)

      expect(screen.getByLabelText(INPUT)).toHaveValue(FIXED)
      expect(push).toHaveBeenCalledTimes(1)
      // Page 1 again; an explicit non-default size is kept.
      expect(push).toHaveBeenCalledWith(searchUrl(FIXED, { pageSize: '24' }))
      expect(fullLocal().at(-1)).toBe(localUrl(FIXED, 1, 24))
      expect(suggestions()).toHaveLength(0)
    })
  })

  describe('адреса, Back і Forward', () => {
    it('Back до іншого пошуку відновлює текст і обидві половини без пауз', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(5_000)

      act(() => {
        navigate(searchUrl('Тигро'))
      })
      await advance(0)

      expect(screen.getByLabelText(INPUT)).toHaveValue('Тигро')
      expect(fullLocal().at(-1)).toBe(localUrl('Тигро'))
      expect(fullExternal().at(-1)).toBe(externalUrl('Тигро'))
    })

    it('Back/Forward до сторінки набраного пошуку: та сама сторінка, таймер набору адреси не скидає', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(5_000)

      act(() => {
        navigate('/catalog/new?q=%D0%9A%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2')
      })
      await advance(5_000)

      expect(fullLocal().at(-1)).toBe(localUrl('Кобзар', 2))
      expect(fullExternal().at(-1)).toBe(externalUrl('Кобзар', 2))
      expect(searchParams.get('page')).toBe('2')
      expect(replace).toHaveBeenCalledTimes(1)
    })

    it('стара адреса підказок (auto=1): повний пошук того самого q, адреса без auto, жодного обмеженого списку', async () => {
      searchParams = new URLSearchParams({ q: 'Тигро', auto: '1' })

      renderScreen()
      await advance(0)

      expect(replace).toHaveBeenCalledWith(searchUrl('Тигро'), undefined)
      expect(screen.getByLabelText(INPUT)).toHaveValue('Тигро')
      expect(fullLocal()).toEqual([localUrl('Тигро')])
      expect(fullExternal()).toEqual([externalUrl('Тигро')])
      expect(suggestions()).toHaveLength(0)
      expect(
        screen.queryByRole('button', { name: 'Показати всі результати' }),
      ).not.toBeInTheDocument()
    })

    it('адреса, яку пише сам набір, не затирає те, що людина друкує далі', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Ко')
      await advance(350)
      await user.type(screen.getByLabelText(INPUT), 'бз')

      expect(screen.getByLabelText(INPUT)).toHaveValue('Кобз')
    })
  })
})

describe('перемикання між пошуком і ручною формою', () => {
  const SCANNED = '9783161484100'

  it('спосіб додавання BARCODE переживає похід у ручну форму й назад', async () => {
    searchParams = new URLSearchParams()

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))
    await screen.findByText('Кобзар')

    act(() => {
      navigate(`/catalog/new?mode=manual&isbn=${SCANNED}`)
    })
    expect(await screen.findByRole('heading', { name: 'Додати книжку вручну' })).toBeInTheDocument()

    act(() => {
      navigate(`/catalog/new?q=${SCANNED}`)
    })
    await screen.findByText('Кобзар')
    await addFromCard(user)
    await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })

    expect(quickAddCalls()[0]?.entryMethod).toBe('BARCODE')
  })

  it('стан додавання переживає похід у ручну форму й назад: те саме видання лишається доданим', async () => {
    const user = userEvent.setup()

    renderScreen()
    await addFromCard(user)
    await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })

    act(() => {
      navigate('/catalog/new?mode=manual&title=x')
    })
    expect(await screen.findByRole('heading', { name: 'Додати книжку вручну' })).toBeInTheDocument()

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80')
    })

    expect(await screen.findByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
  })
})

describe('діалог результату (BS-114)', () => {
  const INPUT = 'Назва, автор або ISBN'

  function searchRequests(): string[] {
    return mockApiRequest.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith('/me/library/add-search'))
  }

  /** A quick-add answer the test releases itself: the request stays in flight until then. */
  function deferQuickAdd(): () => Promise<void> {
    const waiting: (() => void)[] = []

    quickAddHandler = (body) =>
      new Promise((resolve) => {
        waiting.push(() => {
          resolve(addedResponse(body))
        })
      })

    return async () => {
      await act(async () => {
        waiting.shift()?.()
      })
    }
  }

  async function closeWith(user: User, how: 'button' | 'escape'): Promise<void> {
    if (how === 'escape') await user.keyboard('{Escape}')
    else
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Закрити' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  }

  it('вибір відкриває діалог: назва — його доступне імʼя, автори й дані видання; фокус — на заголовку', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openCard(user)

    expect(dialog).toHaveAccessibleName('Кобзар')
    // base-ui moves the initial focus once the popup is mounted.
    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'Кобзар' })).toHaveFocus()
    })
    expect(within(dialog).getByText('Тарас Шевченко')).toBeInTheDocument()

    for (const [label, value] of [
      ['Мова', 'українська'],
      ['Видавництво', 'Наука'],
      ['Рік видання', '2019'],
      ['ISBN', '9783161484100'],
    ] as const) {
      expect(within(dialog).getByText(label).nextElementSibling).toHaveTextContent(value)
    }

    expect(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Закрити' })).toBeInTheDocument()
  })

  it.each(['button', 'escape'] as const)(
    'закриття (%s) нічого не створює, не чіпає адреси й пошуку та повертає фокус до картки',
    async (how) => {
      searchParams = new URLSearchParams('q=кобзар&page=2&pageSize=24')

      const user = userEvent.setup()

      renderScreen()
      await screen.findByText('Кобзар')

      const asked = searchRequests()
      const choose = within(cardAt(0)).getByRole('button', { name: 'Кобзар' })

      await openCard(user)
      await closeWith(user, how)

      expect(choose).toHaveFocus()
      expect(quickAddCalls()).toHaveLength(0)
      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(searchParams.toString()).toBe(
        'q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2&pageSize=24',
      )
      // The same list, not a new search: nothing was asked again, the field keeps its text.
      expect(searchRequests()).toEqual(asked)
      expect(cardAt(0)).toBeInTheDocument()
      expect(screen.getByLabelText(INPUT)).toHaveValue('кобзар')
    },
  )

  it('з клавіатури: Enter на картці відкриває, Tab і Shift+Tab ходять лише всередині діалогу', async () => {
    const user = userEvent.setup()

    renderScreen()

    const choose = await screen.findByRole('button', { name: 'Кобзар' })

    choose.focus()
    await user.keyboard('{Enter}')

    const dialog = await screen.findByRole('dialog')
    const focusedName = (): string => document.activeElement?.textContent ?? ''

    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'Кобзар' })).toHaveFocus()
    })

    // Wrapping around the ends is the focus guards' job — jsdom does not run them, the browser check does.
    for (const name of ['Додати до бібліотеки', 'Уточнити дані', 'Закрити']) {
      await user.tab()
      expect(focusedName()).toBe(name)
    }

    for (const name of ['Уточнити дані', 'Додати до бібліотеки']) {
      await user.tab({ shift: true })
      expect(focusedName()).toBe(name)
    }

    // Nothing behind the modal dialog is reachable: the page under it is inert.
    expect(choose.closest('[inert], [aria-hidden="true"]')).not.toBeNull()

    await closeWith(user, 'escape')
    expect(choose).toHaveFocus()
  })

  it('закриття під час запиту не скасовує операції; повторне відкриття показує її актуальний стан', async () => {
    const finish = deferQuickAdd()
    const user = userEvent.setup()

    renderScreen()
    await addFromCard(user)
    await screen.findByRole('button', { name: 'Додаю…' })
    // Refining now would be a second, different operation.
    expect(screen.queryByRole('link', { name: 'Уточнити дані' })).not.toBeInTheDocument()

    await closeWith(user, 'escape')
    expect(within(cardAt(0)).getByText('Додаю…')).toBeInTheDocument()

    let dialog = await openCard(user)

    expect(within(dialog).getByRole('button', { name: 'Додаю…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await closeWith(user, 'button')
    // The late answer only updates the card: no dialog pops up, nobody is carried away.
    await finish()
    await waitFor(() => {
      expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()

    dialog = await openCard(user)
    expect(within(dialog).getByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
  })

  it('пізня відповідь не змінює іншого вибраного результату', async () => {
    items = [editionItem('e-1'), editionItem('e-2', { isbn13: '9780306406157', year: 2010 })]

    const finish = deferQuickAdd()
    const user = userEvent.setup()

    renderScreen()
    await addFromCard(user, 0)
    await screen.findByRole('button', { name: 'Додаю…' })
    await closeWith(user, 'escape')

    const other = await openCard(user, 1)

    expect(within(other).getByText('2010')).toBeInTheDocument()

    await finish()
    await waitFor(() => {
      expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    })
    expect(within(other).getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
    expect(within(other).queryByRole('status')).toBeEmptyDOMElement()
    expect(within(cardAt(1)).queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('після невизначеного результату закриття й повторне відкриття лишають лише повтор тієї самої операції', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await addFromCard(user)
    await screen.findByText(/Не вдалося підтвердити додавання/)
    await closeWith(user, 'escape')
    expect(within(cardAt(0)).getByText('Додавання не підтверджено')).toBeInTheDocument()

    const dialog = await openCard(user)

    expect(within(dialog).queryByRole('button', { name: 'Додати до бібліотеки' })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: 'Уточнити дані' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: 'Перевірити ще раз' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [first, second] = quickAddCalls()

    expect(second).toEqual(first)
  })

  it('довгі назва, автори й ISBN не розпирають діалогу: текст переноситься', async () => {
    const long = 'Дуже'.repeat(60)

    items = [
      editionItem('e-1', {
        work: { ...WORK, title: long },
        authors: [{ ...AUTHORS[0]!, name: 'Автор'.repeat(40) }],
      }),
    ]

    const user = userEvent.setup()

    renderScreen()

    const dialog = await openCard(user)

    expect(within(dialog).getByRole('heading', { name: long })).toHaveClass('wrap-anywhere')
    expect(within(dialog).getByText('Автор'.repeat(40))).toHaveClass('wrap-anywhere')
    expect(within(dialog).getByText('9783161484100')).toHaveClass('wrap-anywhere')
  })
})

describe('«Уточнити дані» наявного видання (BS-114)', () => {
  const DETAIL = {
    work: WORK,
    authors: AUTHORS,
    translations: [],
    editions: [editionItem('e-1').edition],
    viewerCapabilities: {
      canEditWork: true,
      editableEditionIds: ['e-1'],
      editableTranslationIds: [],
    },
  }
  let patchHandler: (path: string, body: unknown) => Promise<unknown>

  beforeEach(() => {
    const searching = mockApiRequest.getMockImplementation()

    patchHandler = () => Promise.reject(new Error('PATCH не очікувався'))
    mockApiRequest.mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        if (options?.method === 'PATCH') return patchHandler(path, options.body)

        return searching?.(path, options)
      },
    )
    // `useWork` reads the work with the redirect-aware request (a merged work answers 301).
    mockApiRequestWithRedirect.mockImplementation((path: string) =>
      path === '/works/work-1'
        ? Promise.resolve({ data: DETAIL, redirected: false })
        : Promise.reject(new Error(`Неочікуваний запит ${path}`)),
    )
  })

  async function openRefine(user: User): Promise<void> {
    const dialog = await openCard(user)
    const href = within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href')

    act(() => {
      navigate(href ?? '')
    })
    await screen.findByRole('region', { name: 'Видання' })
  }

  /** Every request beyond the search: what the refine screen itself sent. */
  function nonSearchCalls(): string[] {
    return [...mockApiRequestWithRedirect.mock.calls, ...mockApiRequest.mock.calls]
      .map(
        ([path, options]) =>
          `${(options as { method?: string } | undefined)?.method ?? 'GET'} ${String(path)}`,
      )
      .filter((call) => !call.startsWith('GET /me/library/add-search'))
  }

  it('посилання несе саме це видання, його твір і пошук для повернення', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openCard(user)
    const href = within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href')

    expect(href).toBe(
      `/catalog/new?mode=manual&editionId=e-1&workId=work-1&${new URLSearchParams({ q: 'кобзар' }).toString()}`,
    )
    // Opening the form saves nothing.
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('повна форма текстом; без виправлень додає лише примірник цього editionId і веде до бібліотеки', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openRefine(user)

    const work = screen.getByRole('region', { name: 'Твір' })
    const edition = screen.getByRole('region', { name: 'Видання' })

    expect(within(work).getByText('Назва').nextElementSibling).toHaveTextContent('Кобзар')
    expect(within(work).getByText('Автори').nextElementSibling).toHaveTextContent('Тарас Шевченко')
    expect(within(edition).getByText('Видавництво').nextElementSibling).toHaveTextContent('Наука')
    expect(within(edition).getByText('ISBN').nextElementSibling).toHaveTextContent('9783161484100')
    expect(screen.getByText(/змінюють спільний каталог/)).toBeInTheDocument()
    expect(linkHref('← До пошуку')).toBe(
      `/catalog/new?${new URLSearchParams({ q: 'кобзар' }).toString()}`,
    )
    expect(quickAddCalls()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/library')
    })

    expect(quickAddCalls()).toEqual([
      expect.objectContaining({ target: { kind: 'EXISTING_EDITION', editionId: 'e-1' } }),
    ])
    // No work, author or edition is created: only the work is read, and the copy added.
    expect(nonSearchCalls()).toEqual(['GET /works/work-1', 'POST /me/library/quick-add'])
  })

  it('стан додавання спільний із карткою пошуку: після додавання з діалогу форма показує «✓», нової операції немає', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await addFromCard(user)

    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })
    act(() => {
      navigate('/catalog/new?mode=manual&editionId=e-1&workId=work-1&q=кобзар')
    })
    await screen.findByRole('region', { name: 'Видання' })

    await user.click(screen.getByRole('button', { name: '✓ У моїй бібліотеці' }))
    expect(quickAddCalls()).toHaveLength(1)
  })

  it('відкрите виправлення блокує додавання, щоб не загубити введене; закрите — знову дозволяє', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openRefine(user)
    await user.click(screen.getByRole('button', { name: 'Виправити дані твору' }))

    expect(screen.getByText(/Це спільні метадані каталогу/)).toBeInTheDocument()
    expect(
      screen.getByText('Щоб додати книжку, спершу збережіть або закрийте виправлення.'),
    ).toBeVisible()

    const add = screen.getByRole('button', { name: 'Додати до бібліотеки' })

    expect(add).toHaveAttribute('aria-disabled', 'true')
    await user.click(add)
    expect(quickAddCalls()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toHaveAttribute(
      'aria-disabled',
      'false',
    )
  })

  it('виправлення спільних даних — лише явним збереженням через чинний PATCH з expectedRevision', async () => {
    const saved: { path: string; body: unknown }[] = []

    patchHandler = (path, body) => {
      saved.push({ path, body })

      return Promise.resolve({ edition: { ...DETAIL.editions[0], publisher: 'Нове', revision: 2 } })
    }

    const user = userEvent.setup()

    renderScreen()
    await openRefine(user)
    await user.click(screen.getByRole('button', { name: 'Виправити дані видання' }))
    await user.click(screen.getByRole('button', { name: 'Редагувати: Видавництво' }))
    await user.clear(screen.getByRole('textbox', { name: 'Видавництво' }))
    await user.type(screen.getByRole('textbox', { name: 'Видавництво' }), 'Нове')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Видавництво' }))

    // A field's own «Зберегти» is local: nothing is sent yet.
    expect(saved).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]).toEqual({
      path: '/editions/e-1',
      body: expect.objectContaining({ publisher: 'Нове', expectedRevision: 1 }),
    })
    expect(quickAddCalls()).toHaveLength(0)
  })

  describe('виправлення під час додавання (рев’ю BS-114)', () => {
    const CORRECTIONS = ['Виправити дані твору', 'Виправити дані видання']

    async function expectCorrectionsLocked(user: User): Promise<void> {
      for (const name of CORRECTIONS) {
        const button = screen.getByRole('button', { name })

        expect(button).toHaveAttribute('aria-disabled', 'true')
        // Mouse/touch and keyboard alike open nothing.
        await user.click(button)
        button.focus()
        await user.keyboard('{Enter}')
        await user.keyboard(' ')
      }

      expect(screen.queryByText(/Це спільні метадані каталогу/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Редагувати: Видавництво' })).toBeNull()
    }

    it('поки додавання триває, обидва виправлення недоступні; пізній успіх не губить чернетки, бо її немає', async () => {
      let finish: (() => void) | undefined

      quickAddHandler = (body) =>
        new Promise((resolve) => {
          finish = () => {
            resolve(addedResponse(body))
          }
        })

      const user = userEvent.setup()

      renderScreen()
      await openRefine(user)
      await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
      await screen.findByRole('button', { name: 'Додаю…' })

      await expectCorrectionsLocked(user)
      expect(
        screen.getByText(/Виправлення недоступні, поки не завершиться додавання/),
      ).toBeVisible()

      await act(async () => {
        finish?.()
      })
      await waitFor(() => {
        expect(push).toHaveBeenCalledWith('/library')
      })
    })

    it('після невизначеного результату виправлення недоступні, доки його не зʼясовано', async () => {
      quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

      const user = userEvent.setup()

      renderScreen()
      await openRefine(user)
      await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
      await screen.findByRole('button', { name: 'Перевірити ще раз' })

      await expectCorrectionsLocked(user)
    })

    it('після однозначної відмови обидва виправлення знову доступні', async () => {
      quickAddHandler = () =>
        Promise.reject(
          new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Видання не знайдено' }),
        )

      const user = userEvent.setup()

      renderScreen()
      await openRefine(user)
      await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
      await screen.findByText('Видання не знайдено')

      for (const name of CORRECTIONS) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'false')
      }

      await user.click(screen.getByRole('button', { name: 'Виправити дані видання' }))
      expect(await screen.findByRole('button', { name: 'Редагувати: Видавництво' })).toBeVisible()
      // The open correction still blocks adding.
      expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
    })
  })

  it('без прав на виправлення — лише дані й додавання, без кнопок виправлення', async () => {
    DETAIL.viewerCapabilities = {
      canEditWork: false,
      editableEditionIds: [],
      editableTranslationIds: [],
    }

    try {
      renderScreen()
      await openRefine(userEvent.setup())

      expect(screen.queryByRole('button', { name: /Виправити/ })).not.toBeInTheDocument()
      expect(screen.queryByText(/змінюють спільний каталог/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
    } finally {
      DETAIL.viewerCapabilities = {
        canEditWork: true,
        editableEditionIds: ['e-1'],
        editableTranslationIds: [],
      }
    }
  })
})

describe('«Уточнити дані» зовнішнього результату (BS-114)', () => {
  beforeEach(() => {
    items = []
  })

  async function refineFromDialog(user: User): Promise<URLSearchParams> {
    const dialog = await openCard(user)
    const href =
      within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href') ?? ''

    act(() => {
      navigate(href)
    })
    await screen.findByRole('heading', { name: 'Додати книжку вручну' })

    return new URLSearchParams(href.split('?')[1])
  }

  it('конкретне видання: у повну форму йдуть усі відомі поля, роки твору й видання окремо', async () => {
    externalItems = [
      {
        kind: 'EXTERNAL',
        key: 'external:GOOGLE_BOOKS:vol-9',
        result: {
          id: 'GOOGLE_BOOKS:vol-9',
          kind: 'EDITION',
          sources: ['GOOGLE_BOOKS'],
          title: 'Повна назва',
          authors: ['Перший Автор', 'Другий Автор'],
          isbn13: '9780306406157',
          language: 'en',
          publisher: 'Видавець',
          publishedYear: 2019,
          firstPublishedYear: 1937,
          pageCount: 320,
          format: 'PAPERBACK',
          coverUrl: 'https://covers.example/9.jpg',
        },
      },
    ]

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Повна назва')

    const parameters = await refineFromDialog(user)

    expect(parameters.get('q')).toBe('кобзар')
    expect(linkHref('← До пошуку')).toBe(
      `/catalog/new?${new URLSearchParams({ q: 'кобзар' }).toString()}`,
    )

    for (const [label, value] of [
      ['Назва', 'Повна назва'],
      ['ISBN-13', '9780306406157'],
      ['Мова видання', 'англійська'],
      ['Видавництво', 'Видавець'],
      ['Рік видання', '2019'],
      ['Сторінок', '320'],
      ['Палітурка', 'мʼяка'],
      ['Обкладинка (посилання)', 'https://covers.example/9.jpg'],
      ['Рік першого видання твору', '1937'],
    ] as const) {
      expect(within(await manualField(label)).getByText(value)).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })

    expect(quickAddCalls()[0]).toMatchObject({
      entryMethod: 'MANUAL',
      target: {
        kind: 'MANUAL',
        work: {
          title: 'Повна назва',
          firstPubYear: 1937,
          authors: [{ name: 'Перший Автор' }, { name: 'Другий Автор' }],
        },
        edition: {
          textKind: 'UNKNOWN',
          lang: 'en',
          isbn13: '9780306406157',
          publisher: 'Видавець',
          year: 2019,
          pageCount: 320,
          format: 'PAPERBACK',
          coverUrl: 'https://covers.example/9.jpg',
        },
      },
    })
  })

  it('ISBN уже є в каталозі: чинний сценарій «Додати наявне видання» лишається', async () => {
    externalItems = [externalEdition('vol-1', { isbn13: '9780306406157', title: 'Конфлікт' })]

    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(
            new ApiRequestError(409, {
              code: 'EDITION_ISBN_TAKEN',
              message: 'Видання з таким ISBN уже є',
              details: { editionId: 'e-known' },
            }),
          )
        : Promise.resolve(addedResponse(body))
    }

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Конфлікт')
    await refineFromDialog(user)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await user.click(await screen.findByRole('button', { name: 'Додати наявне видання' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })

    expect(quickAddCalls()[1]).toMatchObject({
      target: { kind: 'EXISTING_EDITION', editionId: 'e-known' },
    })
  })

  it('результат пошуку за ISBN: форма отримує ISBN і все, що повідомило джерело', async () => {
    searchParams = new URLSearchParams('q=9783161484100')
    lookupHandler = () =>
      Promise.resolve({
        result: {
          title: 'Знайдена за ISBN',
          authors: ['Автор'],
          publisher: 'Видавець',
          publishedYear: 2021,
          language: 'uk',
          source: 'GOOGLE_BOOKS',
        },
      })

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Знайдена за ISBN')

    const parameters = await refineFromDialog(user)

    expect(Object.fromEntries([...parameters].filter(([key]) => key !== 'mode'))).toEqual({
      title: 'Знайдена за ISBN',
      author: 'Автор',
      isbn: '9783161484100',
      lang: 'uk',
      publisher: 'Видавець',
      year: '2021',
      q: '9783161484100',
    })
    expect(within(await manualField('Видавництво')).getByText('Видавець')).toBeInTheDocument()
  })
})

describe('успіх повної форми й пізня відповідь (BS-114)', () => {
  beforeEach(() => {
    items = [editionItem('e-1')]
  })

  it('ручна форма: пізня відповідь після повернення до пошуку не переносить до бібліотеки', async () => {
    searchParams = new URLSearchParams('mode=manual&title=Нова&q=кобзар')

    let finish: (() => void) | undefined

    quickAddHandler = (body) =>
      new Promise((resolve) => {
        finish = () => {
          resolve({
            ...addedResponse({ operationId: body.operationId, target: { editionId: 'e-new' } }),
          })
        }
      })

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })

    act(() => {
      navigate('/catalog/new?q=кобзар')
    })
    await screen.findByRole('button', { name: 'Кобзар' })
    await act(async () => {
      finish?.()
    })

    // The answer still lands — but the person is not carried away from where they went.
    await waitFor(() => {
      expect(window.sessionStorage.length).toBe(0)
    })
    expect(push).not.toHaveBeenCalled()
  })
})

describe('різні ручні форми — різні наміри (рев’ю BS-114)', () => {
  const A = externalEdition('vol-a', { isbn13: '9783161484100', title: 'Книжка A' })
  const B = externalEdition('vol-b', { isbn13: '9780306406157', title: 'Книжка B' })
  const SEARCH = `/catalog/new?${new URLSearchParams({ q: 'кобзар' }).toString()}`

  beforeEach(() => {
    items = []
    externalItems = [A, B]
  })

  /** From the search: the card's dialog → «Уточнити дані» → the prefilled manual form. */
  async function refine(user: User, index: number): Promise<string> {
    const dialog = await openCard(user, index)
    const href =
      within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href') ?? ''

    act(() => {
      navigate(href)
    })
    await screen.findByRole('heading', { name: 'Додати книжку вручну' })

    return href
  }

  async function backToSearch(): Promise<void> {
    act(() => {
      navigate(SEARCH)
    })
    await screen.findByText('Книжка B')
  }

  it('A в польоті → пошук → форма B → успіх A: B лишається з власною чернеткою й станом', async () => {
    let finish: (() => void) | undefined

    quickAddHandler = (body) =>
      new Promise((resolve) => {
        finish = () => {
          resolve(addedResponse({ operationId: body.operationId, target: { editionId: 'e-a' } }))
        }
      })

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Книжка A')
    await refine(user, 0)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByRole('button', { name: 'Додаю…' })

    await backToSearch()
    await refine(user, 1)

    // B is a new intent: nothing of A's operation shows here, and its fields are open for editing.
    expect(within(await manualField('Назва')).getByText('Книжка B')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toHaveAttribute(
      'aria-disabled',
      'false',
    )
    expect(screen.queryByText(/Не вдалося підтвердити/)).not.toBeInTheDocument()

    await openManualEditor(user, 'Видавництво')
    await user.type(screen.getByRole('textbox', { name: 'Видавництво' }), 'Чернетка B')

    await act(async () => {
      finish?.()
    })
    await waitFor(() => {
      expect(window.sessionStorage.length).toBe(0)
    })

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Додати книжку вручну' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Видавництво' })).toHaveValue('Чернетка B')
    expect(within(await manualField('Назва')).getByText('Книжка B')).toBeInTheDocument()
    expect(screen.queryByText('Книжку додано до вашої бібліотеки.')).not.toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
  })

  it('невизначений результат A переживає переходи: B чиста, у формі A — повтор того самого запиту', async () => {
    let attempt = 0

    quickAddHandler = (body) => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(
            addedResponse({ operationId: body.operationId, target: { editionId: 'e-a' } }),
          )
    }

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Книжка A')

    const hrefA = await refine(user, 0)

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByRole('button', { name: 'Перевірити ще раз' })

    await backToSearch()
    await refine(user, 1)

    expect(screen.queryByRole('button', { name: 'Перевірити ще раз' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Не вдалося підтвердити/)).not.toBeInTheDocument()

    act(() => {
      navigate(hrefA)
    })
    await user.click(await screen.findByRole('button', { name: 'Перевірити ще раз' }))
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/library')
    })

    const [first, second] = quickAddCalls()

    expect(quickAddCalls()).toHaveLength(2)
    expect(second).toEqual(first)
  })

  it('успіх власної активної форми, як і раніше, відкриває бібліотеку', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Книжка A')
    await refine(user, 0)
    await backToSearch()
    await refine(user, 1)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/library')
    })
    // The form was not changed, so the record keeps its identity (BS-114 «Уточнити дані»).
    expect(quickAddCalls()[0]).toMatchObject({
      target: {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: 'vol-b',
        isbn13: '9780306406157',
      },
    })
  })

  it('однакова назва — не однакова ідентичність: два записи з тією самою назвою — два наміри', async () => {
    externalItems = [
      externalEdition('vol-1', { isbn13: '9783161484100', title: 'Однакова' }),
      externalEdition('vol-2', { isbn13: '9780306406157', title: 'Однакова' }),
    ]

    quickAddHandler = () => new Promise(() => undefined)

    const user = userEvent.setup()

    renderScreen()
    await screen.findAllByText('Однакова')
    await refine(user, 0)
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByRole('button', { name: 'Додаю…' })

    act(() => {
      navigate(SEARCH)
    })
    await screen.findAllByText('Однакова')
    await refine(user, 1)

    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
  })
})

describe('зовнішній запис твору без видання (BS-114)', () => {
  const COVER = 'https://covers.openlibrary.org/b/id/6498519-M.jpg'
  const WORK_RECORD: AddSearchExternalItem = {
    kind: 'EXTERNAL',
    key: 'external:OPEN_LIBRARY:OL45804W',
    result: {
      id: 'OPEN_LIBRARY:OL45804W',
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: 'Fantastic Mr Fox',
      authors: ['Roald Dahl'],
      firstPublishedYear: 1970,
      coverUrl: COVER,
      externalId: 'OL45804W',
      workExternalId: 'OL45804W',
    },
  }

  beforeEach(() => {
    items = []
    externalItems = [WORK_RECORD]
    quickAddHandler = (body) =>
      Promise.resolve(
        addedResponse({ operationId: body.operationId, target: { editionId: 'e-olw' } }),
      )
  })

  async function refineFromDialog(user: User): Promise<URLSearchParams> {
    const dialog = await openCard(user)
    const href =
      within(dialog).getByRole('link', { name: 'Уточнити дані' }).getAttribute('href') ?? ''

    act(() => {
      navigate(href)
    })
    await screen.findByRole('heading', { name: 'Додати книжку вручну' })

    return new URLSearchParams(href.split('?')[1])
  }

  it('додається одним натисканням без форми: на сервер іде лише запис, діалог і пошук лишаються', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Fantastic Mr Fox')

    const dialog = await openCard(user)

    expect(
      within(dialog).getByRole('img', { name: 'Обкладинка «Fantastic Mr Fox»' }),
    ).toHaveAttribute('src', expect.stringContaining('6498519'))
    expect(within(dialog).getByText('Уперше видано')).toBeInTheDocument()
    expect(within(dialog).queryByText('Рік видання')).not.toBeInTheDocument()
    expect(
      within(dialog).getByText(/видавництво, рік видання й ISBN лишаться невідомими/),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Уточнити дані' })).toBeInTheDocument()
    // Opening the dialog sends nothing.
    expect(quickAddCalls()).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: 'Додати до бібліотеки' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    expect(quickAddCalls()).toEqual([
      {
        operationId: expect.any(String),
        entryMethod: 'MANUAL',
        target: { kind: 'EXTERNAL_WORK', source: 'OPEN_LIBRARY', externalId: 'OL45804W' },
      },
    ])
    expect(push).not.toHaveBeenCalled()
    expect(searchParams.toString()).toBe(new URLSearchParams({ q: 'кобзар' }).toString())
    // A second copy of the same book is a separate, explicit action.
    expect(
      within(dialog).getByRole('button', { name: 'Додати ще один примірник' }),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Закрити' }))

    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
  })

  it('подвійне натискання — один запит; невизначений результат повторюється тим самим operationId', async () => {
    let attempt = 0
    let release!: () => void

    quickAddHandler = (body) => {
      attempt += 1

      if (attempt === 1) {
        return new Promise((_, reject) => {
          release = () => {
            reject(new TypeError('Failed to fetch'))
          }
        })
      }

      return Promise.resolve(
        addedResponse({ operationId: body.operationId, target: { editionId: 'e-olw' } }),
      )
    }

    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Fantastic Mr Fox')

    const dialog = await openCard(user)
    const add = within(dialog).getByRole('button', { name: 'Додати до бібліотеки' })

    await user.click(add)
    await user.click(add)

    expect(quickAddCalls()).toHaveLength(1)

    act(() => {
      release()
    })
    await user.click(await within(dialog).findByRole('button', { name: 'Перевірити ще раз' }))
    await within(dialog).findByRole('button', { name: '✓ У моїй бібліотеці' })

    const [first, second] = quickAddCalls()

    expect(quickAddCalls()).toHaveLength(2)
    expect(second).toEqual(first)
  })

  it('«Уточнити дані» несе обкладинку й запис; відкриття форми нічого не створює', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Fantastic Mr Fox')

    const parameters = await refineFromDialog(user)

    expect(parameters.get('coverUrl')).toBe(COVER)
    expect(parameters.get('record')).toBe('OPEN_LIBRARY:OL45804W')
    expect(parameters.get('firstPubYear')).toBe('1970')
    expect(parameters.has('year')).toBe(false)
    expect(parameters.has('isbn')).toBe(false)
    expect(quickAddCalls()).toHaveLength(0)

    await user.click(screen.getByText('Додатково'))

    expect(within(await manualField('Обкладинка (посилання)')).getByText(COVER)).toBeInTheDocument()
  })

  it('уточнення без змін у полях твору зберігає запис: додані поля видання — лише як доповнення', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Fantastic Mr Fox')
    await refineFromDialog(user)
    await user.click(screen.getByText('Додатково'))
    await openManualEditor(user, 'Видавництво')
    await user.type(screen.getByLabelText('Видавництво'), 'Puffin')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Видавництво' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/library')
    })
    // The cover and the work's data are the record's: the server takes them from the source.
    expect(quickAddCalls()).toEqual([
      {
        operationId: expect.any(String),
        entryMethod: 'MANUAL',
        // BS-79: a full form always sends the new copy's visibility explicitly.
        copy: { visibility: 'FRIENDS' },
        target: {
          kind: 'EXTERNAL_WORK',
          source: 'OPEN_LIBRARY',
          externalId: 'OL45804W',
          edition: { publisher: 'Puffin' },
        },
      },
    ])
  })

  it('змінена назва — власний запис людини без звʼязку, обкладинка зберігається', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('Fantastic Mr Fox')
    await refineFromDialog(user)
    await openManualEditor(user, 'Назва')
    await user.clear(screen.getByRole('textbox', { name: 'Назва' }))
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Незвичайний пан Лис')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Назва' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })
    expect(quickAddCalls()[0]?.target).toEqual({
      kind: 'MANUAL',
      work: { title: 'Незвичайний пан Лис', firstPubYear: 1970, authors: [{ name: 'Roald Dahl' }] },
      edition: { textKind: 'UNKNOWN', coverUrl: COVER },
    })
  })
})
