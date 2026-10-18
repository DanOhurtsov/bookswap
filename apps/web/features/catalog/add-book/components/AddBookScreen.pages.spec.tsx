/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import {
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  type AddSearchEditionItem,
} from '@bookswap/shared'
import { QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import { AddBookScreen } from './AddBookScreen'

/**
 * BS-134: the add-book search's pages — the controls under the grid, and the current page plus the two
 * after it in one shared cache (docs/plan/bs-134-search-grid-pagination.md). The API is a mock that
 * answers per path and can hold any answer back, so the ORDER of requests is observable. The client
 * keeps what it loads (`gcTime: Infinity`), as the real one does for minutes.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

let viewer = 'me'

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: {
      status: 'authenticated',
      user: {
        id: viewer,
        displayName: 'Тест',
        email: 't@example.com',
        libraryVisibility: 'FRIENDS',
      },
    },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

let searchParams = new URLSearchParams()
const push = jest.fn()
const replace = jest.fn()
const listeners = new Set<() => void>()

/** Moves the address and re-renders whoever reads it, as the real router does. */
function navigate(href: string): void {
  searchParams = new URLSearchParams(href.split('?')[1] ?? '')
  listeners.forEach((listener) => {
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
      replace: (href: string, options?: { scroll?: boolean }) => {
        replace(href, options)
        navigate(href)
      },
    }),
    useSearchParams: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener)

          return () => {
            listeners.delete(listener)
          }
        },
        () => searchParams,
        () => searchParams,
      ),
  }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const WORK = {
  id: 'work-1',
  title: 'Кобзар',
  origLang: 'uk',
  firstPubYear: 1840,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

function edition(title: string): AddSearchEditionItem {
  return {
    kind: 'EDITION',
    key: `edition:${title}`,
    edition: {
      id: title,
      workId: 'work-1',
      translationId: null,
      textKind: 'ORIGINAL',
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: null,
      lang: null,
      translator: null,
      revision: 1,
    },
    work: { ...WORK, title },
    authors: [],
    matchedOn: 'TITLE',
    ownership: { activeCount: 0, archivedCount: 0 },
  }
}

interface Asked {
  half: 'local' | 'external'
  q: string
  page: number
  pageSize: number
  signal: AbortSignal | undefined
}

/** Every search request, in order. */
let asked: Asked[]
/** Answers held back: a test releases them by half and page. */
let held: Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>
let hold: (request: Asked) => boolean
let localAnswer: (request: Asked) => unknown
let externalAnswer: (request: Asked) => unknown

const keyOf = (half: Asked['half'], page: number) => `${half}:${String(page)}`

/** A local page with one card named after it, saying whether more local rows follow. */
function localPage(request: Asked, hasMore: boolean) {
  return {
    items: [edition(`${request.q} — сторінка ${String(request.page)}`)],
    page: request.page,
    pageSize: request.pageSize,
    total: 0,
    hasMore,
  }
}

function externalPage(request: Asked, more: 'YES' | 'NO' | 'UNKNOWN', complete = true) {
  return {
    items: [],
    sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
    page: request.page,
    pageSize: request.pageSize,
    more,
    complete,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  window.sessionStorage.clear()
  viewer = 'me'
  asked = []
  held = new Map()
  hold = () => false
  // Seven pages of our own catalog; the sources have nothing.
  localAnswer = (request) => localPage(request, request.page < 7)
  externalAnswer = (request) => externalPage(request, 'NO')
  searchParams = new URLSearchParams({ q: 'кобзар' })
  apiRequest.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
    const parameters = new URLSearchParams(path.split('?')[1] ?? '')
    const half = path.startsWith('/me/library/add-search/external?')
      ? 'external'
      : path.startsWith('/me/library/add-search?')
        ? 'local'
        : undefined

    if (half === undefined) return Promise.reject(new Error(`Неочікуваний запит ${path}`))

    const request: Asked = {
      half,
      q: parameters.get('q') ?? '',
      page: Number(parameters.get('page')),
      pageSize: Number(parameters.get('pageSize')),
      signal: options?.signal,
    }

    asked.push(request)

    if (hold(request)) {
      return new Promise((resolve, reject) => {
        held.set(keyOf(half, request.page), { resolve, reject })
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }

    return Promise.resolve(half === 'local' ? localAnswer(request) : externalAnswer(request))
  })
})

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
}

function renderScreen(queryClient = client()) {
  return { ...render(withQueryClient(<AddBookScreen />, queryClient)), queryClient }
}

/** Pages asked of one half, in order (`q` included when it is not the default query). */
const pagesAsked = (half: Asked['half'], q = 'кобзар') =>
  asked.filter((request) => request.half === half && request.q === q).map((request) => request.page)

async function release(half: Asked['half'], page: number, value: unknown): Promise<void> {
  await act(async () => {
    held.get(keyOf(half, page))?.resolve(value)
  })
}

/** The request made `index`-th (negative — from the end); a test that names one expects it. */
function askedAt(index: number): Asked {
  const request = asked.at(index)

  if (request === undefined) throw new Error(`Запиту №${String(index)} не було`)

  return request
}

const pageTitle = (page: number, q = 'кобзар') => `${q} — сторінка ${String(page)}`
/** `кобзар` as the address encodes it. */
const KOBZAR = '%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80'
const nav = () => screen.queryByRole('navigation', { name: 'Сторінки результатів' })

describe('пагінація під сіткою', () => {
  it('нуль результатів: навігації немає, розмір сторінки є', async () => {
    localAnswer = (request) => ({ ...localPage(request, false), items: [] })
    renderScreen()

    expect(await screen.findByText('Нічого схожого не знайшлося.')).toBeInTheDocument()
    expect(nav()).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toBeInTheDocument()
  })

  it('одна сторінка: навігації немає, розмір сторінки є, наперед нічого не вантажиться', async () => {
    localAnswer = (request) => localPage(request, false)
    renderScreen()

    expect(await screen.findByText(pageTitle(1))).toBeInTheDocument()
    expect(nav()).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toBeInTheDocument()
    expect(pagesAsked('local')).toEqual([1])
  })

  it('кілька сторінок: навігація під сіткою з номером підтвердженої другої', async () => {
    renderScreen()

    await screen.findByText(pageTitle(1))

    const pages = await screen.findByRole('navigation', { name: 'Сторінки результатів' })

    expect(within(pages).getByRole('link', { name: 'Сторінка 1, поточна' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(pages).getByRole('link', { name: 'Сторінка 2' })).toHaveAttribute(
      'href',
      '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2',
    )

    // Under the grid: the last card comes before the controls in the document.
    const cards = document.querySelectorAll("li[data-slot='result-card']")
    const last = cards[cards.length - 1]

    expect(last?.compareDocumentPosition(pages)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('UNKNOWN: «Далі» без номера непідтвердженої сторінки — і це не кінець', async () => {
    localAnswer = (request) => localPage(request, false)
    externalAnswer = (request) => externalPage(request, 'UNKNOWN')
    // Page 2 is still on its way: nothing proves it yet (once loaded, its rows would — see below).
    hold = (request) => request.page === 2
    renderScreen()

    await screen.findByText(pageTitle(1))
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('link', { name: 'Сторінка 2' })).not.toBeInTheDocument()
    // The unproven page is still loaded ahead: UNKNOWN is not the end.
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2])
    })
  })

  it('на SEARCH_MAX_PAGE «Далі» немає, і наперед нічого не вантажиться', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар', page: String(SEARCH_MAX_PAGE) })
    localAnswer = (request) => localPage(request, true)
    renderScreen()

    expect(await screen.findByText(pageTitle(SEARCH_MAX_PAGE))).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Наступна сторінка' })).not.toBeInTheDocument()
    expect(pagesAsked('local')).toEqual([SEARCH_MAX_PAGE])
  })

  it('порожня глибока сторінка: повідомлення й шлях на першу', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар', page: '9' })
    localAnswer = (request) => ({ ...localPage(request, false), items: [] })
    renderScreen()

    expect(await screen.findByText('На цій сторінці результатів немає.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Сторінка 1' })).toHaveAttribute(
      'href',
      '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80',
    )
  })

  it('посилання сторінок і розмір зберігають виконаний запит і розмір сторінки', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар', page: '2', pageSize: '24' })
    renderScreen()

    await screen.findByText(pageTitle(2))
    expect(screen.getByRole('link', { name: 'Сторінка 1' })).toHaveAttribute(
      'href',
      '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&pageSize=24',
    )
    expect(asked[0]).toMatchObject({ q: 'кобзар', page: 2, pageSize: 24 })
  })
})

describe('дві сторінки наперед', () => {
  it('сторінка 1 показується одразу, без очікування фону; потім послідовно 2, і лише після неї 3', async () => {
    hold = (request) => request.page > 1
    renderScreen()

    expect(await screen.findByText(pageTitle(1))).toBeInTheDocument()
    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })
    // Both halves of page 2 at once, like the page on screen; page 3 waits for page 2.
    expect(pagesAsked('external')).toEqual([1, 2])

    await release('local', 2, localPage(askedAt(2), true))
    expect(pagesAsked('local')).toEqual([1, 2])
    await release('external', 2, externalPage(askedAt(3), 'NO'))

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3])
    })
    // Background loading moves nothing: not the address, not the page shown.
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText(pageTitle(1))).toBeInTheDocument()
  })

  it('перехід на 2 бере готові дані без запиту й довантажує лише 4; перехід на 3 — лише 5', async () => {
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3])
    })

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2')
    })

    expect(screen.getByText(pageTitle(2))).toBeInTheDocument()
    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3, 4])
    })

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=3')
    })

    expect(screen.getByText(pageTitle(3))).toBeInTheDocument()
    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3, 4, 5])
    })
    expect(pagesAsked('external')).toEqual([1, 2, 3, 4, 5])
  })

  it('пряме відкриття сторінки N: спершу N, тоді N+1 і N+2', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар', page: '4' })
    renderScreen()

    expect(await screen.findByText(pageTitle(4))).toBeInTheDocument()
    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([4, 5, 6])
    })
  })

  it('перехід на сторінку, запит якої ще в польоті, приєднується до нього — без дубля', async () => {
    hold = (request) => request.page === 2
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2')
    })
    await release('local', 2, localPage(askedAt(2), true))
    await release('external', 2, externalPage(askedAt(3), 'NO'))

    expect(await screen.findByText(pageTitle(2))).toBeInTheDocument()
    expect(pagesAsked('local').filter((page) => page === 2)).toHaveLength(1)
    expect(pagesAsked('external').filter((page) => page === 2)).toHaveLength(1)
  })

  it('після підтвердженого кінця наступні сторінки не питаються', async () => {
    localAnswer = (request) => localPage(request, request.page < 2)
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(pagesAsked('local')).toEqual([1, 2])
  })

  it('неповна фонова сторінка (complete=false) довантажується тим самим запитом, перш ніж черга піде далі', async () => {
    const answered = new Map<number, number>()

    localAnswer = (request) => localPage(request, false)
    externalAnswer = (request) => {
      const count = (answered.get(request.page) ?? 0) + 1

      answered.set(request.page, count)

      return request.page === 2 && count === 1
        ? externalPage(request, 'UNKNOWN', false)
        : externalPage(request, request.page < 3 ? 'YES' : 'NO')
    }
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2, 2, 3])
    })
  })

  it('фонова помилка не прибирає поточної сторінки; перехід на неї питає знову', async () => {
    let failed = false

    localAnswer = (request) => {
      if (request.page === 2 && !failed) {
        failed = true
        throw new Error('збій')
      }

      return localPage(request, true)
    }
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })
    expect(screen.getByText(pageTitle(1))).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2')
    })

    expect(await screen.findByText(pageTitle(2))).toBeInTheDocument()
    expect(pagesAsked('local').slice(0, 3)).toEqual([1, 2, 2])
  })

  it('новий запит скасовує стару чергу, а її відповіді не показуються', async () => {
    hold = (request) => request.q === 'кобзар' && request.page === 2
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })

    const oldPage2 = asked.find((request) => request.half === 'local' && request.page === 2)

    act(() => {
      navigate('/catalog/new?q=%D1%82%D0%B8%D0%B3%D1%80%D0%BE')
    })

    expect(await screen.findByText(pageTitle(1, 'тигро'))).toBeInTheDocument()
    expect(oldPage2?.signal?.aborted).toBe(true)
    expect(screen.queryByText(pageTitle(1))).not.toBeInTheDocument()
    expect(pagesAsked('local')).toEqual([1, 2])
    await waitFor(() => {
      expect(pagesAsked('local', 'тигро')).toEqual([1, 2, 3])
    })
  })

  it('зміна розміру сторінки — інший ключ: стара черга скасована, нова починає зі сторінки 1', async () => {
    hold = (request) => request.pageSize === DEFAULT_SEARCH_PAGE_SIZE && request.page === 2
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2])
    })

    const oldPage2 = asked.find((request) => request.page === 2)

    act(() => {
      navigate('/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&pageSize=24')
    })

    await waitFor(() => {
      expect(
        asked
          .filter((request) => request.half === 'local' && request.pageSize === 24)
          .map((r) => r.page),
      ).toEqual([1, 2, 3])
    })
    expect(oldPage2?.signal?.aborted).toBe(true)
  })

  it('без pageSize в адресі: поточна й дві наступні сторінки питають обидві половини по 12', async () => {
    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3])
    })
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2, 3])
    })
    expect(new Set(asked.map((request) => request.pageSize))).toEqual(new Set([12]))
    // The canonical address of the default size carries no pageSize.
    expect(screen.getByRole('link', { name: 'Сторінка 2' })).toHaveAttribute(
      'href',
      `/catalog/new?q=${KOBZAR}&page=2`,
    )
  })

  it('явний розмір 24: запити, сторінки наперед і посилання несуть 24; вибір 12 — сторінка 1, Back бере кеш', async () => {
    searchParams = new URLSearchParams({ q: 'кобзар', page: '2', pageSize: '24' })
    const user = userEvent.setup()

    renderScreen()

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([2, 3, 4])
    })
    expect(new Set(asked.map((request) => request.pageSize))).toEqual(new Set([24]))
    expect(screen.getByRole('link', { name: 'Сторінка 3' })).toHaveAttribute(
      'href',
      `/catalog/new?q=${KOBZAR}&page=3&pageSize=24`,
    )

    await chooseOption(user, 'Результатів на сторінці', '12')

    // Page 1, the same query, the default size dropped from the address.
    expect(push).toHaveBeenLastCalledWith(`/catalog/new?q=${KOBZAR}`)
    await waitFor(() => {
      expect(
        asked
          .filter((request) => request.half === 'local' && request.pageSize === 12)
          .map((request) => request.page),
      ).toEqual([1, 2, 3])
    })

    const before = asked.length

    // Back: the size-24 pages are still in the cache under their own key.
    act(() => {
      navigate(`/catalog/new?q=${KOBZAR}&page=2&pageSize=24`)
    })

    expect(await screen.findByText(pageTitle(2))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Сторінка 2, поточна' })).toBeInTheDocument()
    expect(asked).toHaveLength(before)
  })

  it.each([
    { page: '3', pageSize: '10' },
    { page: '3', pageSize: '20' },
    { page: '3', pageSize: '50' },
    { page: 'abc', pageSize: '24' },
  ])(
    'недопустима адреса page=$page&pageSize=$pageSize: replace на сторінку 1 типового розміру, і жодного запиту за старою адресою',
    async ({ page, pageSize }) => {
      searchParams = new URLSearchParams({ q: 'кобзар', page, pageSize, keep: '1' })
      // The real router moves the address on `replace`; the requests after it must stay the same.
      replace.mockImplementationOnce(navigate)
      renderScreen()

      await waitFor(() => {
        expect(replace.mock.calls.map(([href]) => href)).toEqual([
          `/catalog/new?q=${KOBZAR}&keep=1`,
        ])
      })
      expect(push).not.toHaveBeenCalled()
      expect(await screen.findByText(pageTitle(1))).toBeInTheDocument()
      await waitFor(() => {
        expect(pagesAsked('external')).toEqual([1, 2, 3])
      })
      // From the very first request, both halves ask the corrected page 1 and then the pages ahead
      // of it — never the page or the size the old address named.
      expect(pagesAsked('local')).toEqual([1, 2, 3])
      expect(asked.map((request) => request.pageSize)).toEqual(asked.map(() => 12))
    },
  )

  it('кеш розділений за користувачем: інший обліковий запис питає сам, а не бачить чужих сторінок', async () => {
    const queryClient = client()
    const first = renderScreen(queryClient)

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3])
    })
    first.unmount()

    viewer = 'someone-else'
    renderScreen(queryClient)

    await waitFor(() => {
      expect(pagesAsked('local')).toEqual([1, 2, 3, 1, 2, 3])
    })
  })
})

type SourceStatus = 'OK' | 'ERROR' | 'TIMEOUT' | 'RATE_LIMITED'

/** An external page with its own rows, sources and continuation flags. */
function externalWith(
  request: Asked,
  answer: {
    more: 'YES' | 'NO' | 'UNKNOWN'
    complete?: boolean
    items?: AddSearchEditionItem[]
    sources?: SourceStatus[]
  },
) {
  return {
    ...externalPage(request, answer.more, answer.complete ?? true),
    items: answer.items ?? [],
    sources: (answer.sources ?? ['OK']).map((status, index) => ({
      source: index === 0 ? 'GOOGLE_BOOKS' : 'OPEN_LIBRARY',
      status,
    })),
  }
}

/** Waits until nothing more is in flight, so "no further request" can be asserted. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

describe('навігація враховує підготовлені наступні сторінки (рев’ю BS-134, дефект 1)', () => {
  /** Page 1: our catalog ends here, the sources say UNKNOWN — «Далі» without a number. */
  beforeEach(() => {
    localAnswer = (request) => ({
      ...localPage(request, false),
      items: request.page === 1 ? [edition('лише поточна')] : [],
    })
  })

  const next = () => screen.queryByRole('link', { name: 'Наступна сторінка' })
  const second = () => screen.queryByRole('link', { name: 'Сторінка 2' })

  it('А: непорожня підготовлена сторінка 2 підтверджує свій номер', async () => {
    externalAnswer = (request) =>
      request.page === 1
        ? externalWith(request, { more: 'UNKNOWN' })
        : externalWith(request, { more: 'NO', items: [edition('знайдена у фоні')] })
    renderScreen()

    await waitFor(() => {
      expect(second()).toBeInTheDocument()
    })
    expect(second()).toHaveAttribute(
      'href',
      '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2',
    )
    expect(next()).toBeInTheDocument()
    // Updating the controls asked nothing new: page 2 once per half, and its NO ended the queue.
    await settle()
    expect(pagesAsked('external')).toEqual([1, 2])
    expect(pagesAsked('local')).toEqual([1, 2])
  })

  it('Б: порожня остаточна сторінка 2 з підтвердженим кінцем прибирає «Далі» — навігації немає', async () => {
    externalAnswer = (request) =>
      externalWith(request, { more: request.page === 1 ? 'UNKNOWN' : 'NO' })
    renderScreen()

    await screen.findByText('лише поточна')
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2])
    })
    await waitFor(() => {
      expect(next()).not.toBeInTheDocument()
    })
    expect(nav()).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toBeInTheDocument()
    await settle()
    expect(pagesAsked('external')).toEqual([1, 2])
  })

  it('часткова підготовлена сторінка (complete=false) не доводить кінця: «Далі» лишається без номера', async () => {
    let page2Asks = 0

    hold = (request) => request.half === 'external' && request.page === 2 && page2Asks >= 1
    externalAnswer = (request) => {
      if (request.page === 1) return externalWith(request, { more: 'UNKNOWN' })

      page2Asks += 1

      return externalWith(request, { more: 'UNKNOWN', complete: false })
    }
    renderScreen()

    await screen.findByText('лише поточна')
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2, 2])
    })
    await settle()
    expect(next()).toBeInTheDocument()
    expect(second()).not.toBeInTheDocument()
  })

  it.each<[string, SourceStatus[]]>([
    ['усі джерела зі збоєм', ['ERROR', 'TIMEOUT']],
    ['одне джерело зі збоєм', ['OK', 'RATE_LIMITED']],
  ])('порожня сторінка 2, %s, не доводить кінця: «Далі» лишається', async (_name, sources) => {
    externalAnswer = (request) =>
      request.page === 1
        ? externalWith(request, { more: 'UNKNOWN' })
        : externalWith(request, { more: 'NO', sources })
    renderScreen()

    await screen.findByText('лише поточна')
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2])
    })
    await settle()
    expect(next()).toBeInTheDocument()
    expect(second()).not.toBeInTheDocument()
  })

  it('HTTP-збій підготовленої сторінки 2 не доводить кінця: «Далі» лишається', async () => {
    externalAnswer = (request) => {
      if (request.page === 1) return externalWith(request, { more: 'UNKNOWN' })

      throw new Error('збій')
    }
    renderScreen()

    await screen.findByText('лише поточна')
    await waitFor(() => {
      expect(pagesAsked('external')).toEqual([1, 2])
    })
    await settle()
    expect(next()).toBeInTheDocument()
    expect(second()).not.toBeInTheDocument()
  })

  it('дані іншого запиту, розміру, refresh чи користувача не впливають на навігацію', async () => {
    hold = (request) => request.page === 2
    externalAnswer = (request) => externalWith(request, { more: 'UNKNOWN' })

    const queryClient = client()
    const proving = {
      ...externalWith(
        { half: 'external', q: 'x', page: 2, pageSize: 10, signal: undefined },
        { more: 'NO', items: [edition('чужа')] },
      ),
      results: [edition('чужа')],
    }

    for (const key of [
      ['add-search', 'me', 'інший запит', 10, 0, 'external', 2],
      ['add-search', 'me', 'кобзар', 20, 0, 'external', 2],
      ['add-search', 'me', 'кобзар', 10, 1, 'external', 2],
      ['add-search', 'someone-else', 'кобзар', 10, 0, 'external', 2],
    ]) {
      queryClient.setQueryData(key, proving)
    }
    renderScreen(queryClient)

    await screen.findByText('лише поточна')
    await waitFor(() => {
      expect(next()).toBeInTheDocument()
    })
    expect(second()).not.toBeInTheDocument()
  })
})

describe('повтор після збою провайдерів усередині HTTP 200 (рев’ю BS-134, дефект 2)', () => {
  /** Page 1 proves page 2 by our own catalog; page 2 is the last local page. */
  beforeEach(() => {
    localAnswer = (request) => localPage(request, request.page === 1)
  })

  const page2 = '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2'
  const external2 = () => pagesAsked('external').filter((page) => page === 2)

  it('усі джерела зі збоєм у фоні → перехід на сторінку питає знову → результати відновленого провайдера', async () => {
    let asks = 0

    externalAnswer = (request) => {
      if (request.page !== 2) return externalWith(request, { more: 'NO' })

      asks += 1

      return asks === 1
        ? externalWith(request, { more: 'UNKNOWN', sources: ['ERROR', 'TIMEOUT'] })
        : externalWith(request, { more: 'NO', items: [edition('після відновлення')] })
    }
    renderScreen()

    await waitFor(() => {
      expect(external2()).toHaveLength(1)
    })
    await settle()

    act(() => {
      navigate(page2)
    })

    expect(await screen.findByText(pageTitle(2))).toBeInTheDocument()
    expect(await screen.findByText('після відновлення')).toBeInTheDocument()
    expect(external2()).toHaveLength(2)
    // The local half was final: it is reused, not asked again.
    expect(pagesAsked('local').filter((page) => page === 2)).toHaveLength(1)
  })

  it('частковий збій: отримане лишається на екрані, невдала частина питається знову при переході', async () => {
    let asks = 0
    let releaseRetry: (value: unknown) => void = () => undefined

    hold = (request) => request.half === 'external' && request.page === 2 && asks >= 1
    externalAnswer = (request) => {
      if (request.page !== 2) return externalWith(request, { more: 'NO' })

      asks += 1

      return externalWith(request, {
        more: 'NO',
        items: [edition('від живого джерела')],
        sources: ['OK', 'ERROR'],
      })
    }
    renderScreen()

    await waitFor(() => {
      expect(external2()).toHaveLength(1)
    })
    await settle()

    act(() => {
      navigate(page2)
    })

    // What the live source gave is shown at once, while the failed part is asked again.
    expect(await screen.findByText('від живого джерела')).toBeInTheDocument()
    await waitFor(() => {
      expect(external2()).toHaveLength(2)
    })
    releaseRetry = (value) => held.get('external:2')?.resolve(value)
    await act(async () => {
      releaseRetry(
        externalWith(askedAt(-1), {
          more: 'NO',
          items: [edition('від живого джерела'), edition('від відновленого джерела')],
          sources: ['OK', 'OK'],
        }),
      )
    })

    expect(await screen.findByText('від відновленого джерела')).toBeInTheDocument()
    expect(screen.getByText('від живого джерела')).toBeInTheDocument()
  })

  it('успішна остаточна сторінка й сторінка без опитаних джерел (sources=[]) перевикористовуються без запиту', async () => {
    externalAnswer = (request) =>
      request.page === 2
        ? { ...externalWith(request, { more: 'NO' }), sources: [] }
        : externalWith(request, { more: 'NO' })
    renderScreen()

    await waitFor(() => {
      expect(external2()).toHaveLength(1)
    })
    await settle()

    act(() => {
      navigate(page2)
    })

    expect(screen.getByText(pageTitle(2))).toBeInTheDocument()
    await settle()
    expect(external2()).toHaveLength(1)
  })
})

describe('підтверджений кінець переважає обіцянку сторінки PROVEN (сценарій «три»)', () => {
  /** Page 4 opened directly: our catalog is done, the sources prove page 5 (`more = YES`). */
  beforeEach(() => {
    searchParams = new URLSearchParams({ q: 'три', page: '4' })
    localAnswer = (request) => ({ ...localPage(request, false), items: [] })
  })

  const fifth = () => screen.queryByRole('link', { name: 'Сторінка 5' })
  const next = () => screen.queryByRole('link', { name: 'Наступна сторінка' })
  const page4 = (request: Asked) =>
    externalWith(request, { more: 'YES', items: [edition('три — сторінка 4')] })
  const fifthRequest = (half: Asked['half']): Asked => ({
    half,
    q: 'три',
    page: 5,
    pageSize: 10,
    signal: undefined,
  })
  const tooMany = () =>
    Promise.reject(
      new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
    )

  it('остаточно порожня сторінка 5 прибирає номер 5 і «Далі», щойно prefetch завершився; решта навігації лишається', async () => {
    hold = (request) => request.page === 5
    externalAnswer = (request) => page4(request)
    renderScreen()

    await screen.findByText('три — сторінка 4')
    // While page 5 is on its way, page 4's own proof stands.
    await waitFor(() => {
      expect(fifth()).toBeInTheDocument()
    })
    expect(next()).toBeInTheDocument()

    await release('local', 5, { ...localPage(fifthRequest('local'), false), items: [] })
    await release('external', 5, externalWith(fifthRequest('external'), { more: 'NO' }))

    await waitFor(() => {
      expect(fifth()).not.toBeInTheDocument()
    })
    expect(next()).not.toBeInTheDocument()

    const pages = within(await screen.findByRole('navigation', { name: 'Сторінки результатів' }))

    expect(pages.getByRole('link', { name: 'Сторінка 1' })).toBeInTheDocument()
    expect(pages.getByRole('link', { name: 'Сторінка 3' })).toBeInTheDocument()
    expect(pages.getByRole('link', { name: 'Сторінка 4, поточна' })).toBeInTheDocument()
    // The confirmed end asked nothing further.
    await settle()
    expect(pagesAsked('external', 'три')).toEqual([4, 5])
    expect(pagesAsked('local', 'три')).toEqual([4, 5])
  })

  it('сторінка 5 із записами лишає свій номер, і черга йде до 6', async () => {
    externalAnswer = (request) =>
      request.page === 4
        ? page4(request)
        : externalWith(request, {
            more: request.page === 5 ? 'YES' : 'NO',
            items: [edition(`три — сторінка ${String(request.page)}`)],
          })
    renderScreen()

    await screen.findByText('три — сторінка 4')
    await waitFor(() => {
      expect(pagesAsked('external', 'три')).toEqual([4, 5, 6])
    })
    await settle()
    expect(fifth()).toBeInTheDocument()
    expect(next()).toBeInTheDocument()
  })

  it.each<[string, (request: Asked) => unknown]>([
    ['UNKNOWN', (request) => externalWith(request, { more: 'UNKNOWN' })],
    [
      'часткова відповідь (complete=false)',
      (request) => externalWith(request, { more: 'UNKNOWN', complete: false }),
    ],
    [
      'одне джерело ERROR',
      (request) => externalWith(request, { more: 'NO', sources: ['OK', 'ERROR'] }),
    ],
    [
      'усі джерела TIMEOUT',
      (request) => externalWith(request, { more: 'NO', sources: ['TIMEOUT', 'TIMEOUT'] }),
    ],
    [
      'джерело RATE_LIMITED',
      (request) => externalWith(request, { more: 'NO', sources: ['OK', 'RATE_LIMITED'] }),
    ],
    ['HTTP 429', () => tooMany()],
  ])(
    'порожня сторінка 5 — %s — не доводить кінця: номер 5 і «Далі» лишаються',
    async (_name, fifthAnswer) => {
      let fifthAsks = 0

      // A partial page is asked again at once (continuation): that second ask stays in flight.
      hold = (request) => {
        if (request.half !== 'external' || request.page !== 5) return false

        fifthAsks += 1

        return fifthAsks > 1
      }
      externalAnswer = (request) => (request.page === 4 ? page4(request) : fifthAnswer(request))
      renderScreen()

      await screen.findByText('три — сторінка 4')
      await waitFor(() => {
        expect(pagesAsked('external', 'три').filter((page) => page === 5).length).toBeGreaterThan(0)
      })
      await settle()
      expect(fifth()).toBeInTheDocument()
      expect(next()).toBeInTheDocument()
    },
  )

  it('HTTP 429 на підготовленій сторінці 5: перехід на неї питає знову й показує записи', async () => {
    let fifthAsks = 0

    externalAnswer = (request) => {
      if (request.page === 4) return page4(request)
      if (request.page !== 5) return externalWith(request, { more: 'NO' })

      fifthAsks += 1

      return fifthAsks === 1
        ? tooMany()
        : externalWith(request, { more: 'NO', items: [edition('три — сторінка 5')] })
    }
    renderScreen()

    await screen.findByText('три — сторінка 4')
    await waitFor(() => {
      expect(fifthAsks).toBe(1)
    })
    await settle()
    expect(fifth()).toBeInTheDocument()

    act(() => {
      navigate('/catalog/new?q=%D1%82%D1%80%D0%B8&page=5')
    })

    expect(await screen.findByText('три — сторінка 5')).toBeInTheDocument()
    expect(fifthAsks).toBe(2)
  })

  it('повтор сторінки 5 після збою джерела отримав HTTP 429: уже отримані записи й номер 6 лишаються', async () => {
    let fifthAsks = 0

    externalAnswer = (request) => {
      if (request.page === 4) return page4(request)
      if (request.page !== 5) return externalWith(request, { more: 'YES' })

      fifthAsks += 1

      // Prefetched with Google down — stale, so the visit asks again; that ask is throttled.
      return fifthAsks === 1
        ? externalWith(request, {
            more: 'YES',
            items: [edition('три — сторінка 5')],
            sources: ['OK', 'ERROR'],
          })
        : tooMany()
    }
    renderScreen()

    await screen.findByText('три — сторінка 4')
    await waitFor(() => {
      expect(fifthAsks).toBe(1)
    })
    await settle()

    act(() => {
      navigate('/catalog/new?q=%D1%82%D1%80%D0%B8&page=5')
    })

    await waitFor(() => {
      expect(fifthAsks).toBe(2)
    })
    await settle()
    expect(screen.getByText('три — сторінка 5')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Сторінка 6' })).toBeInTheDocument()
    expect(next()).toBeInTheDocument()
  })

  it('підтверджений кінець іншого запиту, розміру, refresh чи користувача не прибирає номера 5', async () => {
    hold = (request) => request.page === 5
    externalAnswer = (request) => page4(request)

    const queryClient = client()
    const ended = {
      local: { ...localPage(fifthRequest('local'), false), items: [] },
      external: { ...externalWith(fifthRequest('external'), { more: 'NO' }), results: [] },
    }

    for (const prefix of [
      ['add-search', 'me', 'інший запит', 10, 0],
      ['add-search', 'me', 'три', 20, 0],
      ['add-search', 'me', 'три', 10, 1],
      ['add-search', 'someone-else', 'три', 10, 0],
    ]) {
      queryClient.setQueryData([...prefix, 'local', 5], ended.local)
      queryClient.setQueryData([...prefix, 'external', 5], ended.external)
    }
    renderScreen(queryClient)

    await screen.findByText('три — сторінка 4')
    await settle()
    expect(fifth()).toBeInTheDocument()
    expect(next()).toBeInTheDocument()
  })
})
