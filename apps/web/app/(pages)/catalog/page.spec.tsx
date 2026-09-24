/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { CatalogSearchResult, Edition, ExternalSearchResult } from '@bookswap/shared'
import CatalogPage from './page'

/**
 * Основна сторінка каталогу шукає там само, де й майстер додавання: один
 * список, власний каталог і зовнішні джерела разом. Тести тут — саме про
 * wiring сторінки: справжні `useCatalogSearch` і `useExternalSearch`,
 * справжні картки, справжня модель спільного списку.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'me', name: 'Тест', email: 't@example.com' } },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

const push = jest.fn()
let searchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  useSearchParams: () => searchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}

const ISBN = '9786177585113'

function edition(overrides: Partial<Edition> & { id: string }): Edition {
  return {
    workId: 'work-1',
    translationId: null,
    publisher: 'Смолоскип',
    year: 2019,
    isbn13: null,
    pageCount: 320,
    coverUrl: null,
    format: 'HARDCOVER',
    lang: 'uk',
    translator: null,
    revision: 1,
    ...overrides,
  }
}

function localResult(overrides?: {
  id?: string
  title?: string
  editions?: Edition[]
}): CatalogSearchResult {
  return {
    work: {
      id: overrides?.id ?? 'work-1',
      title: overrides?.title ?? 'Тигролови',
      origLang: 'uk',
      firstPubYear: 1944,
      description: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [
      { id: 'author-1', name: 'Іван Багряний', nameLatin: null, role: 'AUTHOR', position: 0 },
    ],
    editions: overrides?.editions ?? [edition({ id: 'edition-1' })],
    matchedOn: 'TITLE',
  }
}

const externalEdition: ExternalSearchResult = {
  id: 'GOOGLE_BOOKS:v1',
  kind: 'EDITION',
  sources: ['GOOGLE_BOOKS'],
  title: 'Тигролови',
  authors: ['Іван Багряний'],
  publishedYear: 2021,
  publisher: 'А-БА-БА-ГА-ЛА-МА-ГА',
}

const OK_SOURCES = [
  { source: 'OPEN_LIBRARY', status: 'OK' },
  { source: 'GOOGLE_BOOKS', status: 'OK' },
]

/** Маршрутизація мока за шляхом — запити паралельні, тож порядок ненадійний. */
function routeApi(handlers: Record<string, () => unknown>) {
  mockApiRequest.mockImplementation((path: string) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) return handler()
    }

    return Promise.reject(new Error(`Unexpected path: ${path}`))
  })
}

/** Прямі діти єдиного списку результатів — вкладені видання картками не є. */
function cards(): HTMLElement[] {
  const lists = screen.getAllByRole('list').filter((list) => list.classList.contains('books'))

  expect(lists).toHaveLength(1)

  return [...(lists[0] as HTMLElement).querySelectorAll(':scope > li')] as HTMLElement[]
}

function renderAt(query: string) {
  searchParams = new URLSearchParams(query === '' ? '' : `q=${query}`)

  return render(<CatalogPage />)
}

beforeEach(() => {
  mockApiRequest.mockReset()
  push.mockReset()
  sessionStorage.clear()
  searchParams = new URLSearchParams()
})

describe('/catalog — спільний список', () => {
  it('за ?q= запускає локальний і зовнішній пошук та малює один список', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [localResult()], authorMatches: [] }),
    })

    renderAt('Тигролови')

    await screen.findByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })

    const rows = cards()
    expect(rows).toHaveLength(2)
    expect(
      rows.map((row) => within(row).getByText(/Наш каталог|Google Books/).textContent),
    ).toEqual(['Наш каталог', 'Google Books'])

    const paths = mockApiRequest.mock.calls.map(([path]: [string]) => path)
    expect(paths.some((path) => path.startsWith('/catalog/search?'))).toBe(true)
    expect(paths.some((path) => path.startsWith('/catalog/search/external?'))).toBe(true)
  })

  it('локальні результати не чекають на зовнішні', async () => {
    const external = deferred<{ results: unknown[]; sources: unknown[] }>()

    routeApi({
      '/catalog/search/external': () => external.promise,
      '/catalog/search': () => Promise.resolve({ results: [localResult()], authorMatches: [] }),
    })

    renderAt('Тигролови')

    // Локальна картка вже на екрані, зовнішні ще йдуть.
    await waitFor(() => {
      expect(cards()).toHaveLength(1)
    })
    expect(screen.getByText('Шукаю ще в Open Library та Google Books…')).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()

    external.resolve({ results: [externalEdition], sources: OK_SOURCES })

    await waitFor(() => {
      expect(cards()).toHaveLength(2)
    })
  })

  it('локальна картка веде на сторінку твору', async () => {
    routeApi({
      '/catalog/search/external': () => Promise.resolve({ results: [], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [localResult()], authorMatches: [] }),
    })

    renderAt('Тигролови')

    const link = await screen.findByRole('link', { name: 'Тигролови' })
    expect(link).toHaveAttribute('href', '/works/work-1')
  })

  it('локальна картка з тим самим ISBN ховає зовнішню', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [{ ...externalEdition, isbn13: ISBN }], sources: OK_SOURCES }),
      '/catalog/search': () =>
        Promise.resolve({
          results: [localResult({ editions: [edition({ id: 'edition-1', isbn13: ISBN })] })],
          authorMatches: [],
        }),
    })

    renderAt('Тигролови')

    await screen.findByRole('link', { name: 'Тигролови' })

    await waitFor(() => {
      expect(cards()).toHaveLength(1)
    })
    expect(within(cards()[0] as HTMLElement).getByText('Наш каталог')).toBeInTheDocument()
  })
})

describe('/catalog — адреса і застарілі відповіді', () => {
  it('надсилання форми переносить запит в URL', async () => {
    routeApi({
      '/catalog/search/external': () => Promise.resolve({ results: [], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('')

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва, автор або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Знайти' }))

    expect(push).toHaveBeenCalledWith(
      '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8',
    )
  })

  it('прямий перехід за адресою одразу шукає, без натискання кнопки', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    expect(await screen.findByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })).toBeInTheDocument()
    expect(screen.getByLabelText('Назва, автор або ISBN')).toHaveValue('Тигролови')
  })

  it('зміна ?q= (назад/вперед) підхоплюється полем і новим пошуком', async () => {
    routeApi({
      '/catalog/search/external': () => Promise.resolve({ results: [], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [localResult()], authorMatches: [] }),
    })

    const { rerender } = renderAt('Тигролови')
    await screen.findByRole('link', { name: 'Тигролови' })

    searchParams = new URLSearchParams('q=Кобзар')
    rerender(<CatalogPage />)

    expect(screen.getByLabelText('Назва, автор або ISBN')).toHaveValue('Кобзар')
    await waitFor(() => {
      const paths = mockApiRequest.mock.calls.map(([path]: [string]) => path)
      expect(paths.some((path) => path.includes('%D0%9A%D0%BE%D0%B1%D0%B7%D0%B0%D1%80'))).toBe(true)
    })
  })

  it('застаріла зовнішня відповідь не малюється під новим запитом', async () => {
    const stale = deferred<{ results: unknown[]; sources: unknown[] }>()
    const first = encodeURIComponent('Тигролови')

    // Кожен запит отримує СВІЙ проміс: спільний давав би відповідь і новому
    // запиту теж, і тест перевіряв би не те.
    mockApiRequest.mockImplementation((path: string) => {
      if (!path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [], authorMatches: [] })
      }

      return path.includes(first) ? stale.promise : new Promise(() => undefined)
    })

    const { rerender } = renderAt('Тигролови')

    searchParams = new URLSearchParams('q=Кобзар')
    rerender(<CatalogPage />)

    // Відповідь на ПОПЕРЕДНІЙ запит. Вона не має ні з'явитися у списку, ні
    // перетворити «ще шукаю» на «нічого не знайдено».
    stale.resolve({ results: [externalEdition], sources: OK_SOURCES })

    await waitFor(() => {
      expect(screen.getByText('Шукаю ще в Open Library та Google Books…')).toBeInTheDocument()
    })
    expect(screen.queryByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()
  })

  it('ISBN не йде в зовнішній пошук за назвою', async () => {
    routeApi({
      '/catalog/search': () => Promise.resolve({ results: [localResult()], authorMatches: [] }),
    })

    renderAt(ISBN)

    await screen.findByRole('link', { name: 'Тигролови' })

    const paths = mockApiRequest.mock.calls.map(([path]: [string]) => path)
    expect(paths.some((path) => path.startsWith('/catalog/search/external'))).toBe(false)
  })
})

describe('/catalog — порожньо проти недоступності', () => {
  it('«нічого не знайшлося» лише після відповіді обох пошуків', async () => {
    const external = deferred<{ results: unknown[]; sources: unknown[] }>()

    routeApi({
      '/catalog/search/external': () => external.promise,
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    expect(await screen.findByText('Шукаю ще в Open Library та Google Books…')).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()

    external.resolve({ results: [], sources: OK_SOURCES })

    expect(await screen.findByText(/Нічого схожого не знайшлося/)).toBeInTheDocument()
  })

  it('недоступність джерел читається інакше, ніж порожня видача', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
            { source: 'GOOGLE_BOOKS', status: 'ERROR' },
          ],
        }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    expect(await screen.findByText(/чи є там ця книжка, невідомо/)).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()
  })

  it('часткова недоступність названа поіменно й не ховає знайденого', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
            { source: 'GOOGLE_BOOKS', status: 'OK' },
          ],
        }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    expect(await screen.findByText(/Open Library не відповіла вчасно/)).toBeInTheDocument()
    expect(cards()).toHaveLength(1)
  })
})

describe('/catalog — помилка локального пошуку', () => {
  function failingLocalSearch() {
    return {
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.reject(new Error('база не відповідає')),
    }
  }

  it('лишає ручне додавання доступним', async () => {
    routeApi(failingLocalSearch())

    renderAt('Тигролови')

    const link = await screen.findByRole('link', { name: 'Додати книжку вручну' })
    expect(link).toHaveAttribute(
      'href',
      '/catalog/new?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8',
    )
  })

  it('показує помилку й не видає її за відсутність книжки', async () => {
    routeApi(failingLocalSearch())

    renderAt('Тигролови')

    await screen.findByRole('link', { name: 'Додати книжку вручну' })

    // Саме повідомлення складає `describeError`; тут важливо, що збій ВИДНО.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()
    expect(screen.queryByText(/чи є там ця книжка, невідомо/)).not.toBeInTheDocument()
  })

  it('зовнішні результати лишаються доступними', async () => {
    routeApi(failingLocalSearch())

    renderAt('Тигролови')

    expect(await screen.findByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })).toBeInTheDocument()
    expect(cards()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Вибрати це видання' })).toBeInTheDocument()
  })

  it('коли впали й локальний пошук, і джерела — це теж не «нічого немає»', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
            { source: 'GOOGLE_BOOKS', status: 'ERROR' },
          ],
        }),
      '/catalog/search': () => Promise.reject(new Error('база не відповідає')),
    })

    renderAt('Тигролови')

    await screen.findByRole('link', { name: 'Додати книжку вручну' })
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()
  })
})

describe('/catalog — передавання зовнішнього запису в додавання', () => {
  it('вибір зовнішньої картки веде в майстер саме з цим записом', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    const target = push.mock.calls.at(-1)?.[0] as string
    expect(target).toMatch(
      /^\/catalog\/new\?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&external=.+$/u,
    )

    // Сам запис їде не в адресі: вона б його розкрила й зробила посилання
    // таким, що відновлює чужий вибір. В адресі — лише токен переходу.
    const stored = Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key))
    expect(stored.join('')).toContain('GOOGLE_BOOKS:v1')
    expect(target).not.toContain('GOOGLE_BOOKS')

    // Токен в адресі — саме той, що лежить у сховищі разом із записом.
    const token = new URLSearchParams(target.split('?')[1]).get('external')
    expect(stored.join('')).toContain(`"token":"${String(token)}"`)
  })

  it('кожен вибір отримує СВІЙ токен', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition, { ...externalEdition, id: 'GOOGLE_BOOKS:v2' }],
          sources: OK_SOURCES,
        }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    const user = userEvent.setup()
    const buttons = await screen.findAllByRole('button', { name: 'Вибрати це видання' })

    await user.click(buttons[0] as HTMLElement)
    const firstToken = new URLSearchParams(
      (push.mock.calls.at(-1)?.[0] as string).split('?')[1],
    ).get('external')

    await user.click(buttons[1] as HTMLElement)
    const secondToken = new URLSearchParams(
      (push.mock.calls.at(-1)?.[0] as string).split('?')[1],
    ).get('external')

    // Інакше адреса першого вибору відкривала б другий.
    expect(secondToken).not.toBe(firstToken)
  })

  it('коли сховище недоступне, майстер відкривається без позначки передавання', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: OK_SOURCES }),
      '/catalog/search': () => Promise.resolve({ results: [], authorMatches: [] }),
    })

    renderAt('Тигролови')

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    // Без `external=1`: вдавати, що вибір передано, не можна — майстер покаже
    // звичайний пошук із тим самим запитом.
    expect(push).toHaveBeenCalledWith(
      '/catalog/new?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8',
    )

    setItem.mockRestore()
  })
})
