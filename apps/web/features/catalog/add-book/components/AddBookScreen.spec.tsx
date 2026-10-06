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
import { AddBookScreen } from './AddBookScreen'

/**
 * Екран додавання (docs/plan/fast-book-add.md, §2.1–2.3, QA1, QA6, QA8, QA9): одна картка = одне видання,
 * кнопка «Додати до бібліотеки» → «Додаю…» → «✓ У моїй бібліотеці», користувач лишається в результатах,
 * повтор після невизначеного результату йде тією самою операцією.
 *
 * jsdom підтверджує стани, обробники клавіатури, Escape і керування фокусом; реальну адаптивну верстку,
 * прокрутку, touch і браузерний фокус він НЕ підтверджує — вони позначені NOT RUN у runbook.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
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
        navigate(href)
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

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

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

let items: AddSearchItem[]
/** Додаткові поля відповіді повного пошуку (наприклад, `spellingSuggestion`). */
let fullExtra: Partial<AddSearchResponse>
let externalItems: AddSearchExternalItem[]
let externalHandler: () => Promise<unknown>
let lookupHandler: () => Promise<{ result: BookLookupResult }>
let quickAddHandler: (body: QuickAddBody) => Promise<QuickAddResponse>
/** Автопошук: `?q=` у шляху — щоб тест міг відповідати на різні тексти по-різному. */
let suggestHandler: (query: string) => Promise<unknown>
let suggestExternalHandler: (query: string) => Promise<unknown>

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
  suggestHandler = () => Promise.resolve(searchResponse(items, { pageSize: 8 }))
  suggestExternalHandler = () =>
    Promise.resolve({
      items: externalItems,
      sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
      page: 1,
      pageSize: 8,
      more: 'NO',
      complete: true,
    })
  mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
    if (path.startsWith('/me/library/add-search/suggest/external?')) {
      return suggestExternalHandler(queryOf(path))
    }
    if (path.startsWith('/me/library/add-search/suggest?')) return suggestHandler(queryOf(path))
    if (path.startsWith('/me/library/add-search?')) {
      return Promise.resolve(searchResponse(items, fullExtra))
    }
    if (path.startsWith('/me/library/add-search/external?')) return externalHandler()
    if (path.startsWith('/catalog/lookup?')) return lookupHandler()
    if (path === '/me/library/quick-add') return quickAddHandler(options?.body as QuickAddBody)

    return Promise.reject(new Error(`Неочікуваний запит ${path}`))
  })
})

function queryOf(path: string): string {
  return decodeURIComponent(new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '')
}

function renderScreen() {
  return render(withQueryClient(<AddBookScreen />))
}

describe('результати: одна картка — одне видання', () => {
  it('питає локальний пошук з q, page і pageSize та показує ознаки видання', async () => {
    renderScreen()

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/add-search?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=1&pageSize=10',
      expect.anything(),
    )
    expect(screen.getByText('Тарас Шевченко')).toBeInTheDocument()
    expect(screen.getByText(/Наука/)).toBeInTheDocument()
    expect(screen.getByText(/2019/)).toBeInTheDocument()
    expect(screen.getByText(/українська/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
  })

  it('ISBN і джерело — у деталях; невідомі поля не вигадуються', async () => {
    items = [editionItem('e-1', { isbn13: null })]
    renderScreen()

    await screen.findByText('Кобзар')

    const card = cardAt(0)

    expect(within(card).getByText('Деталі видання')).toBeInTheDocument()
    expect(within(card).queryByText(/ISBN/)).not.toBeInTheDocument()
    expect(within(card).getByText('Джерело: каталог BookSwap')).toBeInTheDocument()
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

    expect(screen.queryByRole('button', { name: /Додати до бібліотеки/ })).not.toBeInTheDocument()
    expect(screen.getByText('Для цього твору ще немає конкретного видання.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Відкрити твір' })).toHaveAttribute(
      'href',
      '/works/w-9',
    )
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
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByRole('button', { name: 'Додаю…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()

    await act(async () => {
      finish?.()
    })

    expect(await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(screen.getByText('«Кобзар» додано до бібліотеки.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'До бібліотеки' })).toHaveAttribute('href', '/library')
    expect(screen.getByRole('button', { name: /Налаштувати примірник/ })).toBeInTheDocument()

    // Адреса пошуку не змінилась: запит, сторінка й позиція прокрутки збережені.
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText('Кобзар')).toBeInTheDocument()
  })

  it('надсилає одну операцію з operationId, видом цілі та способом додавання', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('✓ У моїй бібліотеці')

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

    const button = await screen.findByRole('button', { name: 'Додати до бібліотеки' })

    await user.dblClick(button)
    await screen.findByText('✓ У моїй бібліотеці')

    expect(quickAddCalls()).toHaveLength(1)
  })

  it('після сканування спосіб додавання — BARCODE', async () => {
    searchParams = new URLSearchParams()

    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('✓ У моїй бібліотеці')

    expect(quickAddCalls()[0]?.entryMethod).toBe('BARCODE')
  })

  it('видання, яке вже є в бібліотеці, показується відразу; ще один примірник — явна нова операція', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 1, archivedCount: 0 } })]

    const user = userEvent.setup()

    renderScreen()

    expect(await screen.findByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Додати до бібліотеки' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати ще один примірник' }))
    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(1)
    })
    await screen.findByText('«Кобзар» додано до бібліотеки.')

    await user.click(screen.getByRole('button', { name: 'Додати ще один примірник' }))
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

    const owned = cardAt(0)
    const other = cardAt(1)

    expect(within(owned).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(within(other).getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
  })

  it('архівний примірник — окремий стан із переходом до відновлення; додати можна й новий', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 0, archivedCount: 1 } })]
    renderScreen()

    expect(await screen.findByRole('link', { name: 'Відновити з архіву' })).toHaveAttribute(
      'href',
      '/library?view=archive',
    )
    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
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
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/Не вдалося підтвердити додавання/)).toBeInTheDocument()
    expect(screen.queryByText('✓ У моїй бібліотеці')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await screen.findByText('✓ У моїй бібліотеці')

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
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText('Видання не знайдено')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('✓ У моїй бібліотеці')

    const [first, second] = quickAddCalls()

    expect(first?.operationId).not.toBe(second?.operationId)
  })

  it('незавершена операція переживає перезавантаження і повторюється тією самою операцією', async () => {
    quickAddHandler = () => Promise.reject(new TypeError('Failed to fetch'))

    const user = userEvent.setup()
    const first = renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText(/Не вдалося підтвердити додавання/)

    const interrupted = quickAddCalls()[0]

    first.unmount()
    quickAddHandler = (body) => Promise.resolve(addedResponse(body))
    renderScreen()

    expect(await screen.findByText('«Кобзар» додано до бібліотеки.')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(2)
    expect(quickAddCalls()[1]).toEqual(interrupted)
    expect(window.sessionStorage.length).toBe(0)
  })
})

describe('панель «Мій примірник» (QA8)', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await user.click(await screen.findByRole('button', { name: /Налаштувати примірник/ }))

    return screen.findByRole('dialog')
  }

  it('«Налаштувати» відкриває панель із полями; закриття нічого не скасовує', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openSettings(user)

    expect(within(dialog).getByText('Мій примірник')).toBeInTheDocument()
    expect(within(dialog).getByText('Книжка вже у вашій бібліотеці.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Стан примірника')).toHaveValue('GOOD')
    expect(within(dialog).getByLabelText('Кому показувати')).toHaveValue('FRIENDS')
    expect(within(dialog).getByLabelText('Приватна нотатка')).toHaveValue('')
    expect(within(dialog).getByRole('link', { name: 'Уточнити' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
  })

  it('пояснює фактичну видимість: суворіше обмеження бібліотеки діє першим', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openSettings(user)

    expect(within(dialog).getByText('Бачить: ваші друзі.')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText('Кому показувати'), 'PUBLIC')

    expect(
      within(dialog).getByText(/Суворіше обмеження вашої бібліотеки діє першим/),
    ).toBeInTheDocument()
  })

  it('зберігає зміни чинним PATCH; помилка не закриває панель і не скидає ввід', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openSettings(user)
    let calls = 0

    mockApiRequest.mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        if (options?.method === 'PATCH') {
          calls += 1

          return calls === 1
            ? Promise.reject(
                new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій збереження' }),
              )
            : Promise.resolve({
                copy: addedResponse({ operationId: 'abcd-x', target: { editionId: 'e-1' } }).copy,
              })
        }

        return Promise.reject(new Error(`Неочікуваний запит ${path}`))
      },
    )

    await user.selectOptions(within(dialog).getByLabelText('Стан примірника'), 'WORN')
    await user.type(within(dialog).getByLabelText('Приватна нотатка'), '  з плямою  ')
    await user.click(within(dialog).getByRole('button', { name: 'Зберегти зміни' }))

    expect(await within(dialog).findByText('Збій збереження')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Приватна нотатка')).toHaveValue('  з плямою  ')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Зберегти зміни' }))

    expect(await within(dialog).findByText('Зміни збережено.')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/me\/library\/copy-/),
      expect.objectContaining({
        method: 'PATCH',
        body: { condition: 'WORN', visibility: 'FRIENDS', note: 'з плямою', acquiredAt: null },
      }),
    )
  })

  it('незбережений ввід: закриття питає підтвердження; «Скасувати» лишає панель із текстом', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openSettings(user)

    await user.type(within(dialog).getByLabelText('Приватна нотатка'), 'нотатка')
    await user.keyboard('{Escape}')

    const confirm = await screen.findByRole('alertdialog')

    expect(within(confirm).getByText('Закрити без збереження?')).toBeInTheDocument()

    await user.click(within(confirm).getByRole('button', { name: 'Скасувати' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByLabelText('Приватна нотатка')).toHaveValue(
      'нотатка',
    )
  })

  it('підтверджене закриття лишає примірник у бібліотеці', async () => {
    const user = userEvent.setup()

    renderScreen()

    const dialog = await openSettings(user)

    await user.type(within(dialog).getByLabelText('Приватна нотатка'), 'нотатка')
    await user.click(within(dialog).getByRole('button', { name: 'Закрити налаштування' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Закрити без збереження',
      }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '✓ У моїй бібліотеці' })).toBeInTheDocument()
  })

  it('після закриття панелі фокус повертається на кнопку «Налаштувати»', async () => {
    const user = userEvent.setup()

    renderScreen()
    await openSettings(user)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Налаштувати примірник/ })).toHaveFocus()
    })
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

    expect(within(card).getByText('Джерело: Google Books')).toBeInTheDocument()
    expect(within(card).getByText(/Видавець/)).toBeInTheDocument()
    expect(within(card).getByText(/українська/)).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('✓ У моїй бібліотеці')

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
    expect(screen.queryByRole('button', { name: /Додати до бібліотеки/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Запис про твір, а не про конкретне видання/)).toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /Додати до бібліотеки/ })).not.toBeInTheDocument()
  })

  it('наше видання серед зовнішніх результатів — локальна картка з власним станом, без мережі джерела', async () => {
    externalItems = [
      editionItem('e-known', { ownership: { activeCount: 1, archivedCount: 0 } }),
      externalEdition('vol-2'),
    ]
    renderScreen()

    await screen.findByText('Зовнішня vol-2')

    expect(within(cardAt(0)).getByText('Джерело: каталог BookSwap')).toBeInTheDocument()
    expect(within(cardAt(0)).getByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(
      within(cardAt(1)).getByRole('button', { name: 'Додати до бібліотеки' }),
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
    await user.click(within(cardAt(0)).getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findAllByRole('button', { name: 'Додаю…' })

    // Друга картка того самого видання не може запустити другої операції.
    await user.click(within(cardAt(1)).getByRole('button', { name: 'Додаю…' }))
    expect(quickAddCalls()).toHaveLength(1)

    await act(async () => {
      finish?.()
    })
    await waitFor(() => {
      expect(screen.getAllByText('✓ У моїй бібліотеці')).toHaveLength(2)
    })
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
    expect(screen.getByRole('button', { name: 'Додати до бібліотеки' })).toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('✓ У моїй бібліотеці')

    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).toMatchObject({ target: { kind: 'EXTERNAL_EDITION', isbn13: ISBN } })
  })

  it('другий примірник через ISBN: «Додати ще один примірник» передає additional — нова операція з іншим operationId', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
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
      '/catalog/new?mode=manual&title=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80',
    )
  })

  it('для ISBN-запиту посилання несе ISBN, а не назву', async () => {
    searchParams = new URLSearchParams(`q=${MANUAL_ISBN}`)
    lookupHandler = () => Promise.reject(new Error('немає'))
    renderScreen()

    expect(await screen.findByRole('link', { name: 'Додати вручну' })).toHaveAttribute(
      'href',
      `/catalog/new?mode=manual&isbn=${MANUAL_ISBN}`,
    )
  })

  it('форма підхоплює відоме з адреси й додає книжку однією операцією; невідоме не надсилається', async () => {
    const user = userEvent.setup()

    renderScreen()

    expect(await screen.findByLabelText('Назва')).toHaveValue('Нова книжка')

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
    expect(screen.getByText('«Кобзар» додано до бібліотеки.')).toBeInTheDocument()
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
    await user.type(await screen.findByLabelText('ISBN-13'), '1234567890123')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/Некоректний ISBN-13/)).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(0)
  })

  it('заповнена форма: автори, мова видання, «це оригінал», ISBN і видавництво — в одному запиті', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.type(await screen.findByLabelText('Автор'), 'Тарас Шевченко')
    await user.click(screen.getByRole('button', { name: 'Додати автора' }))
    await user.type(screen.getByLabelText('Автор 2'), 'Співавтор')
    await user.selectOptions(screen.getByLabelText('Мова видання'), 'uk')
    await user.click(screen.getByLabelText('Ні — це оригінал'))
    await user.type(screen.getByLabelText('ISBN-13'), '978-3-16-148410-0')
    await user.click(screen.getByText('Додатково'))
    await user.type(screen.getByLabelText('Видавництво'), 'Наука')
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
    await user.click(await screen.findByLabelText('Так — це переклад'))
    await user.click(screen.getByText('Переклад (необов’язково)'))
    await user.type(screen.getByLabelText('Перекладач'), 'Олена Оніщук')
    await user.selectOptions(screen.getByLabelText('Мова перекладу'), 'uk')
    await user.selectOptions(screen.getByLabelText('З якої мови перекладено'), 'en')
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
    await user.type(await screen.findByLabelText('ISBN-13'), MANUAL_ISBN)
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
    expect(screen.getByLabelText('Назва')).toBeDisabled()

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
    await user.type(await screen.findByLabelText('Автор'), 'Автор')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText('Відхилено сервером')).toBeInTheDocument()
    expect(screen.getByLabelText('Автор')).toHaveValue('Автор')

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

    expect(await screen.findByLabelText('Назва')).toHaveValue('Нова книжка')

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
    expect(screen.queryByLabelText('Назва')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText('Книжку додано до вашої бібліотеки.')

    expect(quickAddCalls()[0]).toMatchObject({
      target: { kind: 'MANUAL', work: { workId: 'w-77' } },
    })
  })
})

describe('твір без видання та запис про твір: «Уточнити видання»', () => {
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

    expect(await screen.findByRole('link', { name: 'Уточнити видання' })).toHaveAttribute(
      'href',
      '/catalog/new?mode=manual&workId=w-9',
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

    const href =
      (await screen.findByRole('link', { name: 'Уточнити видання' })).getAttribute('href') ?? ''
    const parameters = new URLSearchParams(href.split('?')[1])

    expect(parameters.get('mode')).toBe('manual')
    expect(parameters.get('title')).toBe('Запис про твір')
    expect(parameters.getAll('author')).toEqual(['Автор Один', 'Автор Два'])
    expect(parameters.get('firstPubYear')).toBe('1937')
    expect(parameters.has('isbn')).toBe(false)
  })
})

describe('автопошук під час введення', () => {
  const INPUT = 'Назва, автор або ISBN'

  /** Шляхи всіх запитів за префіксом: рахуємо те, що справді пішло на сервер. */
  function requested(prefix: string): string[] {
    return mockApiRequest.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith(prefix))
  }

  const localSuggest = () => requested('/me/library/add-search/suggest?')
  const externalSuggest = () => requested('/me/library/add-search/suggest/external?')
  const fullLocal = () => requested('/me/library/add-search?')
  const fullExternal = () => requested('/me/library/add-search/external?')

  const advance = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }

  function setup() {
    return userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  }

  beforeEach(() => {
    jest.useFakeTimers()
    searchParams = new URLSearchParams()
    items = [editionItem('e-1')]
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('від 2 символів через 350 мс: підказки з нашого каталогу, адреса — replace без прокручування', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')

    expect(localSuggest()).toHaveLength(0)
    await advance(349)
    expect(localSuggest()).toHaveLength(0)
    await advance(1)

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(localSuggest()).toEqual(['/me/library/add-search/suggest?q=%D0%9A%D0%BE'])
    expect(replace).toHaveBeenCalledWith('/catalog/new?q=%D0%9A%D0%BE&auto=1', { scroll: false })
    expect(push).not.toHaveBeenCalled()
    expect(fullLocal()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Показати всі результати' })).toBeInTheDocument()
  })

  it('1 символ нічого не шукає, а 2 символи не питають зовнішнє джерело', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'К')
    await advance(10_000)
    expect(localSuggest()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(INPUT), 'о')
    await advance(10_000)
    expect(localSuggest()).toHaveLength(1)
    expect(externalSuggest()).toHaveLength(0)
  })

  it('від 3 символів через 900 мс після ОСТАННЬОЇ зміни: один зовнішній запит, лише підказковий endpoint', async () => {
    externalItems = [externalEdition('vol-1', { isbn13: '9783161484100' })]

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобз')
    await advance(899)
    expect(externalSuggest()).toHaveLength(0)
    await advance(1)

    expect(await screen.findByText('Зовнішня vol-1')).toBeInTheDocument()
    expect(externalSuggest()).toEqual([
      '/me/library/add-search/suggest/external?q=%D0%9A%D0%BE%D0%B1%D0%B7',
    ])
    // Повний зовнішній пошук (з continuation) від набору не запускається ніколи.
    expect(fullExternal()).toHaveLength(0)
    expect(fullLocal()).toHaveLength(0)
  })

  it('швидкий набір слова — один запит на кожну половину', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(5_000)

    expect(localSuggest()).toHaveLength(1)
    expect(externalSuggest()).toHaveLength(1)
  })

  it('автопошук не дочитує: навіть коли сервер каже «більше є», запит один і без повторів', async () => {
    suggestExternalHandler = () =>
      Promise.resolve({
        items: [externalEdition('vol-1')],
        sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        page: 1,
        pageSize: 8,
        more: 'YES',
        complete: true,
      })

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(60_000)

    expect(externalSuggest()).toHaveLength(1)
    expect(fullExternal()).toHaveLength(0)
  })

  it('Enter до завершення таймерів: рівно один повний пошук, підказки не запускаються', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(200)
    await user.keyboard('{Enter}')
    await advance(10_000)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/catalog/new?q=%D0%9A%D0%BE%D0%B1%D0%B7%D0%B0%D1%80')
    expect(localSuggest()).toHaveLength(0)
    expect(externalSuggest()).toHaveLength(0)
    expect(fullLocal()).toHaveLength(1)
    expect(fullExternal()).toHaveLength(1)
  })

  it('«Показати всі результати» переходить у повний пошук (push, без auto) із пагінацією', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await user.click(await screen.findByRole('button', { name: 'Показати всі результати' }))
    await advance(100)

    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/catalog/new?q=%D0%9A%D0%BE')
    expect(fullLocal()).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: 'Показати всі результати' }),
    ).not.toBeInTheDocument()
  })

  it('старі відповіді не підміняють нові', async () => {
    const pending = new Map<string, (value: unknown) => void>()

    suggestHandler = (query) =>
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
      searchResponse([editionItem('e-1', { work: { ...WORK, title } })], { pageSize: 8 })

    await act(async () => {
      pending.get('Коб')?.(named('Нова відповідь'))
    })
    await act(async () => {
      pending.get('Ко')?.(named('Стара відповідь'))
    })

    expect(await screen.findByText('Нова відповідь')).toBeInTheDocument()
    expect(screen.queryByText('Стара відповідь')).not.toBeInTheDocument()
  })

  it('поки йде новий запит, попередній список лишається, а «нічого не знайдено» не з’являється', async () => {
    const pending = new Map<string, (value: unknown) => void>()

    suggestHandler = (query) =>
      query === 'Ко'
        ? Promise.resolve(searchResponse(items, { pageSize: 8 }))
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
  })

  it('очищення поля прибирає підказки й скасовує очікуване', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(350)
    await screen.findByText('Кобзар')

    await user.clear(screen.getByLabelText(INPUT))
    await advance(10_000)

    expect(replace).toHaveBeenLastCalledWith('/catalog/new', { scroll: false })
    expect(screen.queryByText('Кобзар')).not.toBeInTheDocument()
    expect(externalSuggest()).toHaveLength(0)
  })

  it('IME: під час композиції запитів немає, після compositionend — шукається завершений текст', async () => {
    renderScreen()

    const input = screen.getByLabelText(INPUT)

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'ко' } })
    fireEvent.change(input, { target: { value: 'коб' } })
    await advance(10_000)
    expect(localSuggest()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'кобзар' } })
    fireEvent.compositionEnd(input)
    await advance(350)

    expect(localSuggest()).toEqual([
      '/me/library/add-search/suggest?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80',
    ])
  })

  it('зміна лише пробілів не запускає нового пошуку', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Кобзар')
    await advance(5_000)
    expect(localSuggest()).toHaveLength(1)

    await user.type(screen.getByLabelText(INPUT), '   ')
    await advance(5_000)
    await user.type(screen.getByLabelText(INPUT), '{Backspace}{Backspace}{Backspace}')
    await advance(5_000)

    expect(localSuggest()).toHaveLength(1)
    expect(externalSuggest()).toHaveLength(1)
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
    expect(localSuggest()).toHaveLength(0)
    expect(externalSuggest()).toHaveLength(0)
    expect(fullExternal()).toHaveLength(0)
  })

  it('«1984» шукається як назва, а не як ISBN', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), '1984')
    await advance(350)

    expect(localSuggest()).toEqual(['/me/library/add-search/suggest?q=1984'])
    expect(requested('/catalog/lookup?')).toHaveLength(0)
  })

  describe('недоступність зовнішнього джерела', () => {
    it('429 від endpoint-а: один запит, жодного циклу повторів, місцеві результати й ручне додавання на місці', async () => {
      suggestExternalHandler = () =>
        Promise.reject(
          new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
        )

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(900)

      expect(await screen.findByText('Кобзар')).toBeInTheDocument()
      expect(screen.getByText('Зовнішній пошук тимчасово недоступний.')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Додати вручну' })).toBeInTheDocument()

      await advance(120_000)
      expect(externalSuggest()).toHaveLength(1)
    })

    it('джерело відповіло RATE_LIMITED/TIMEOUT: не «нічого не знайдено», а один нейтральний рядок', async () => {
      items = []
      suggestExternalHandler = () =>
        Promise.resolve({
          items: [],
          sources: [{ source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' }],
          page: 1,
          pageSize: 8,
          more: 'UNKNOWN',
          complete: true,
        })

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(900)

      expect(await screen.findByText(/чи є там ця книжка, невідомо/)).toBeInTheDocument()
      expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()
      expect(externalSuggest()).toHaveLength(1)
    })

    it('підтверджена порожня відповідь — «нічого не знайшлося», але лише коли обидві половини завершені', async () => {
      items = []
      externalItems = []

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(350)
      // Локальна відповідь уже є, зовнішня ще ні: «немає» не кажемо.
      expect(screen.queryByText('Нічого схожого не знайшлося.')).not.toBeInTheDocument()

      await advance(600)
      expect(await screen.findByText('Нічого схожого не знайшлося.')).toBeInTheDocument()
    })
  })

  it('додавання з підказок: «Додаю…» → «✓ У моїй бібліотеці»; запит, список і адреса не змінюються', async () => {
    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    await advance(0)

    expect(await screen.findByText('✓ У моїй бібліотеці')).toBeInTheDocument()
    expect(quickAddCalls()).toHaveLength(1)
    expect(quickAddCalls()[0]).toMatchObject({
      target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
    })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByText('Кобзар')).toBeInTheDocument()
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
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))
    expect(await screen.findByText(/Не вдалося підтвердити додавання/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    await screen.findByText('✓ У моїй бібліотеці')

    const [first, second] = quickAddCalls()

    expect(second).toEqual(first)
  })

  it('«ще один примірник» з підказок — нова операція', async () => {
    items = [editionItem('e-1', { ownership: { activeCount: 1, archivedCount: 0 } })]

    const user = setup()

    renderScreen()
    await user.type(screen.getByLabelText(INPUT), 'Ко')
    await advance(350)
    await user.click(await screen.findByRole('button', { name: 'Додати ще один примірник' }))
    await screen.findByText('«Кобзар» додано до бібліотеки.')
    await user.click(screen.getByRole('button', { name: 'Додати ще один примірник' }))

    await waitFor(() => {
      expect(quickAddCalls()).toHaveLength(2)
    })
    expect(quickAddCalls()[0]?.operationId).not.toBe(quickAddCalls()[1]?.operationId)
  })

  it('твір без видання з підказок веде в уточнення, а не додається', async () => {
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
    expect(screen.queryByRole('button', { name: /Додати до бібліотеки/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Відкрити твір' })).toBeInTheDocument()
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
      suggestHandler = () =>
        Promise.resolve(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))

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

    it('підказка є і в повному пошуку (адреса з q)', async () => {
      searchParams = new URLSearchParams({ q: TYPO })
      fullExtra = hintFor(TYPO)
      externalHandler = externalWithHint

      renderScreen()

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зміна тексту прибирає стару підказку негайно, не чекаючи нової відповіді', async () => {
      suggestHandler = (query) =>
        query === TYPO
          ? Promise.resolve(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))
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
      suggestHandler = () =>
        Promise.resolve(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))

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

      suggestHandler = (query) =>
        query === TYPO
          ? new Promise((resolve) => {
              release = resolve
            })
          : Promise.resolve(searchResponse(items, { pageSize: 8 }))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await user.type(screen.getByLabelText(INPUT), 'а')
      release(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))
      await advance(10_000)

      expect(hintText()).not.toBeInTheDocument()
    })

    it('натискання: поле отримує виправлене написання, одна навігація й один повний пошук, без автопідказок', async () => {
      suggestHandler = () =>
        Promise.resolve(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(10_000)

      expect(screen.getByLabelText(INPUT)).toHaveValue(FIXED)
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith(
        `/catalog/new?${new URLSearchParams({ q: FIXED }).toString()}`,
      )
      expect(fullLocal()).toEqual([
        `/me/library/add-search?q=${encodeURIComponent(FIXED)}&page=1&pageSize=10`,
      ])
      expect(fullExternal()).toHaveLength(1)
      // Єдиний автозапит — той, що показав підказку (до 900 мс зовнішнього ще не було); після натискання нових немає.
      expect(localSuggest()).toHaveLength(1)
      expect(externalSuggest()).toHaveLength(0)
      expect(replace).toHaveBeenCalledTimes(1)
      expect(hintText()).not.toBeInTheDocument()
    })

    it('натискання скидає сторінку результатів на першу', async () => {
      searchParams = new URLSearchParams({ q: TYPO, page: '3', pageSize: '10' })
      fullExtra = hintFor(TYPO)
      externalHandler = externalWithHint

      const user = setup()

      renderScreen()
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(0)

      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith(
        `/catalog/new?${new URLSearchParams({ q: FIXED }).toString()}`,
      )
    })

    it('кнопка доступна з клавіатури: Tab доходить до неї, Enter запускає один пошук', async () => {
      suggestHandler = () =>
        Promise.resolve(searchResponse(items, { pageSize: 8, ...hintFor(TYPO) }))

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
      expect(fullLocal()).toHaveLength(1)
    })
  })

  describe('підказка виправлення з зовнішніх джерел', () => {
    const TYPO = 'Гарі Потер'
    const FIXED = 'Гаррі Поттер'
    const suggestion = { forQuery: TYPO, text: FIXED }
    const externalAnswer = (extra: Record<string, unknown> = {}, sources = 1) => ({
      items: [],
      sources: Array.from({ length: sources }, () => ({ source: 'GOOGLE_BOOKS', status: 'OK' })),
      page: 1,
      pageSize: 8,
      more: 'NO',
      complete: true,
      ...extra,
    })
    const hintText = () => screen.queryByText(/Можливо, ви шукали/)

    beforeEach(() => {
      // Наш каталог порожній: підказка може прийти лише від джерел.
      items = []
      suggestHandler = () => Promise.resolve(searchResponse([], { pageSize: 8 }))
    })

    it('наш каталог порожній, джерело знає правильну назву → підказка з’являється після зовнішньої відповіді', async () => {
      suggestExternalHandler = () =>
        Promise.resolve(externalAnswer({ spellingSuggestion: suggestion }))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(350)
      expect(hintText()).not.toBeInTheDocument()

      await advance(550)

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
      expect(screen.getByLabelText(INPUT)).toHaveValue(TYPO)
      // Жодного запиту понад звичайний автопошук: по одному на половину.
      expect(localSuggest()).toHaveLength(1)
      expect(externalSuggest()).toHaveLength(1)
      expect(fullLocal()).toHaveLength(0)
      expect(fullExternal()).toHaveLength(0)
    })

    it('повний пошук: підказка зовнішньої половини теж під полем', async () => {
      searchParams = new URLSearchParams({ q: TYPO })
      externalHandler = () => Promise.resolve(externalAnswer({ spellingSuggestion: suggestion }))

      renderScreen()

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зовнішня відповідь мовчить (кандидати суперечать) — локальна підказка зникає', async () => {
      suggestHandler = () =>
        Promise.resolve(searchResponse([], { pageSize: 8, spellingSuggestion: suggestion }))
      suggestExternalHandler = () => Promise.resolve(externalAnswer())

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
      suggestHandler = () =>
        Promise.resolve(searchResponse([], { pageSize: 8, spellingSuggestion: suggestion }))
      suggestExternalHandler = () => Promise.resolve(externalAnswer({}, 0))

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(5_000)

      expect(await screen.findByRole('button', { name: FIXED })).toBeInTheDocument()
    })

    it('зміна тексту прибирає підказку з джерела негайно', async () => {
      suggestExternalHandler = (query) =>
        query === TYPO
          ? Promise.resolve(externalAnswer({ spellingSuggestion: suggestion }))
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

      suggestExternalHandler = (query) =>
        query === TYPO
          ? new Promise((resolve) => {
              release = resolve
            })
          : Promise.resolve(externalAnswer())

      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), TYPO)
      await advance(900)
      await user.type(screen.getByLabelText(INPUT), 'а')
      release(externalAnswer({ spellingSuggestion: suggestion }))
      await advance(10_000)

      expect(hintText()).not.toBeInTheDocument()
    })

    it('натискання на підказку з джерела: одна навігація, один повний пошук за виправленим запитом зі сторінки 1', async () => {
      searchParams = new URLSearchParams({ q: TYPO, page: '2', pageSize: '10' })
      externalHandler = () => Promise.resolve(externalAnswer({ spellingSuggestion: suggestion }))

      const user = setup()

      renderScreen()
      await user.click(await screen.findByRole('button', { name: FIXED }))
      await advance(10_000)

      expect(screen.getByLabelText(INPUT)).toHaveValue(FIXED)
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith(
        `/catalog/new?${new URLSearchParams({ q: FIXED }).toString()}`,
      )
      expect(fullLocal().at(-1)).toBe(
        `/me/library/add-search?q=${encodeURIComponent(FIXED)}&page=1&pageSize=10`,
      )
      expect(localSuggest()).toHaveLength(0)
      expect(externalSuggest()).toHaveLength(0)
    })
  })

  describe('адреса, Back і Forward', () => {
    it('Back до запису підказок відновлює текст і зовнішнє питання без нових пауз', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(5_000)
      expect(externalSuggest()).toHaveLength(1)

      // Користувач пішов у повний пошук, а тоді «Назад» — до іншого запису підказок.
      act(() => {
        navigate('/catalog/new?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE&auto=1')
      })
      await advance(0)

      expect(screen.getByLabelText(INPUT)).toHaveValue('Тигро')
      expect(localSuggest().at(-1)).toBe(
        '/me/library/add-search/suggest?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE',
      )
      expect(externalSuggest().at(-1)).toBe(
        '/me/library/add-search/suggest/external?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE',
      )
    })

    it('перехід до адреси повного пошуку: поле слідує за нею, працюють повні запити, підказок немає', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Кобзар')
      await advance(5_000)

      const before = localSuggest().length

      act(() => {
        navigate('/catalog/new?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE')
      })
      await advance(5_000)

      expect(screen.getByLabelText(INPUT)).toHaveValue('Тигро')
      expect(fullLocal()).toHaveLength(1)
      expect(fullExternal()).toHaveLength(1)
      expect(localSuggest()).toHaveLength(before)
      expect(
        screen.queryByRole('button', { name: 'Показати всі результати' }),
      ).not.toBeInTheDocument()
    })

    it('адреса, яку пише сам автопошук, не затирає те, що людина друкує далі', async () => {
      const user = setup()

      renderScreen()
      await user.type(screen.getByLabelText(INPUT), 'Ко')
      await advance(350)
      await user.type(screen.getByLabelText(INPUT), 'бз')

      expect(screen.getByLabelText(INPUT)).toHaveValue('Кобз')
    })
  })
})
