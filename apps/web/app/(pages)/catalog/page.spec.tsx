/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { CatalogDiscoveryResponse, CatalogDiscoveryResult } from '@bookswap/shared'
import { QueryClient } from '@tanstack/react-query'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import CatalogPage from './page'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')
  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: { status: 'authenticated', user: { id: 'me' } } }),
}))

const push = jest.fn()
const replace = jest.fn()
let parameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => parameters,
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const candidate: CatalogDiscoveryResult = {
  work: {
    id: 'work-1',
    title: 'Тигролови',
    origLang: 'uk',
    firstPubYear: 1944,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [
    { id: 'author-1', name: 'Іван Багряний', nameLatin: null, role: 'AUTHOR', position: 0 },
  ],
  editions: [
    {
      id: 'edition-1',
      workId: 'work-1',
      translationId: null,
      textKind: 'ORIGINAL',
      publisher: 'КСД',
      year: 2024,
      isbn13: null,
      pageCount: 320,
      coverUrl: null,
      format: 'PAPERBACK',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
  ],
  matchedOn: 'TITLE',
  locations: [
    {
      owner: { id: 'friend-1', displayName: 'Олена', avatarUrl: null },
      relation: 'FRIEND',
      availableCopies: 1,
      copies: [
        {
          id: 'copy-1',
          editionId: 'edition-1',
          translationId: null,
          status: 'AVAILABLE',
          expectedReturnAt: null,
          canRequest: true,
        },
      ],
    },
  ],
}

function response(overrides: Partial<CatalogDiscoveryResponse> = {}): CatalogDiscoveryResponse {
  return {
    results: [candidate],
    page: 1,
    pageSize: 12,
    scope: 'CIRCLE',
    total: 1,
    hasMore: false,
    ...overrides,
  }
}

function renderAt(search = 'q=Тигролови') {
  parameters = new URLSearchParams(search)
  return render(withQueryClient(<CatalogPage />))
}

beforeEach(() => {
  jest.clearAllMocks()
  parameters = new URLSearchParams()
  apiRequest.mockResolvedValue(response())
})

it('searches available copies in my circle by default and never calls external catalogs', async () => {
  renderAt()

  expect(await screen.findByRole('link', { name: 'Тигролови' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'У Олена' })).toHaveAttribute(
    'href',
    '/users/friend-1/library',
  )
  expect(screen.getByRole('combobox', { name: 'Показувати книжки' })).toHaveTextContent(
    'Мої та друзів',
  )
  expect(apiRequest).toHaveBeenCalledWith(
    '/catalog/discover?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=1&pageSize=12&scope=CIRCLE&availability=AVAILABLE&translation=ANY',
    expect.any(Object),
  )
  expect(apiRequest.mock.calls.some(([path]: [string]) => path.includes('/external'))).toBe(false)
})

it('switches to all users, resetting the page and keeping its size', async () => {
  renderAt('q=Тигролови&page=3&pageSize=24')
  await chooseOption(userEvent, 'Показувати книжки', 'Усіх користувачів')

  expect(push).toHaveBeenCalledWith(
    '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&pageSize=24&scope=ALL',
  )
})

it('explains public copies are not borrowable until friendship is accepted', async () => {
  apiRequest.mockResolvedValue(
    response({
      scope: 'ALL',
      results: [
        {
          ...candidate,
          locations: [
            {
              owner: { id: 'other-1', displayName: 'Тарас', avatarUrl: null },
              relation: 'OTHER',
              availableCopies: 1,
              copies: [
                {
                  id: 'copy-2',
                  editionId: 'edition-1',
                  translationId: null,
                  status: 'AVAILABLE',
                  expectedReturnAt: null,
                  canRequest: false,
                },
              ],
            },
          ],
        },
      ],
    }),
  )
  renderAt('q=Тигролови&scope=ALL')

  expect(await screen.findByRole('link', { name: 'У Тарас' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Спочатку додайте власника в друзі' })).toHaveAttribute(
    'href',
    '/friends',
  )
  expect(screen.getByText(/Позичати можна після додавання власника в друзі/)).toBeInTheDocument()
})

it('keeps the page size selector and links on the owned-copy results', async () => {
  apiRequest.mockResolvedValue(response({ page: 2, pageSize: 24, hasMore: true }))
  renderAt('q=Тигролови&page=2&pageSize=24')

  expect(await screen.findByRole('link', { name: 'Тигролови' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toHaveTextContent('24')
  expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toHaveAttribute(
    'href',
    expect.stringContaining('page=3'),
  )
})

it('retries the same search when Find is pressed again after a failure', async () => {
  apiRequest.mockRejectedValueOnce(new Error('Мережа'))
  renderAt()

  expect(await screen.findByRole('alert')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Знайти' }))

  await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2))
  expect(await screen.findByRole('link', { name: 'Тигролови' })).toBeInTheDocument()
})

it('offers adding a copy when nobody in the selected scope has one', async () => {
  apiRequest.mockResolvedValue(response({ results: [], total: 0 }))
  renderAt()

  expect(await screen.findByText(/доступних примірників не знайшлося/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Додати свою книжку' })).toHaveAttribute(
    'href',
    '/catalog/new?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8',
  )
})

it('browses the circle without any text and shows filters', async () => {
  renderAt('')

  expect(await screen.findByRole('link', { name: 'Тигролови' })).toBeInTheDocument()
  expect(apiRequest).toHaveBeenCalledWith(
    '/catalog/discover?page=1&pageSize=12&scope=CIRCLE&availability=AVAILABLE&translation=ANY',
    expect.any(Object),
  )
  expect(screen.getByRole('combobox', { name: 'Доступність' })).toHaveTextContent('Лише доступні')
  expect(screen.getByRole('combobox', { name: 'Мова' })).toHaveTextContent('Будь-яка')
  expect(screen.getByRole('combobox', { name: 'Переклад' })).toHaveTextContent('Будь-який')
})

it('reads filters from the address, sends them, and resets the page when one changes', async () => {
  renderAt('language=uk&translation=TRANSLATED&availability=ANY&page=3')

  await screen.findByRole('link', { name: 'Тигролови' })
  expect(apiRequest).toHaveBeenCalledWith(
    '/catalog/discover?page=3&pageSize=12&scope=CIRCLE&availability=ANY&language=uk&translation=TRANSLATED',
    expect.any(Object),
  )

  await chooseOption(userEvent, 'Мова', 'польська')

  expect(push).toHaveBeenCalledWith('/catalog?availability=ANY&language=pl&translation=TRANSLATED')
})

it('offers by name only the languages the API accepts; «Будь-яка» drops the filter (BS-92)', async () => {
  const user = userEvent.setup()

  renderAt('language=pl&page=2')
  await screen.findByRole('link', { name: 'Тигролови' })
  const requests = apiRequest.mock.calls.length

  expect(screen.getByRole('combobox', { name: 'Мова' })).toHaveTextContent('польська')

  await user.click(screen.getByRole('combobox', { name: 'Мова' }))
  await screen.findByRole('combobox', { name: 'Пошук: Мова' })

  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Будь-яка',
    'українська',
    'англійська',
    'польська',
    'німецька',
    'французька',
    'іспанська',
    'італійська',
    'чеська',
  ])

  await user.keyboard('япон')
  expect(screen.getByText('Нічого не знайдено')).toBeVisible()
  // Searching inside the list changes neither the address nor what is requested.
  expect(push).not.toHaveBeenCalled()
  expect(apiRequest.mock.calls).toHaveLength(requests)

  await user.clear(screen.getByRole('combobox', { name: 'Пошук: Мова' }))
  await user.click(screen.getByRole('option', { name: 'Будь-яка' }))

  expect(push).toHaveBeenCalledTimes(1)
  expect(push).toHaveBeenCalledWith('/catalog')
})

it('a new page size returns to page 1 and keeps the query and filters (BS-92)', async () => {
  renderAt('q=Тигролови&language=uk&page=3')
  await screen.findByRole('link', { name: 'Тигролови' })

  await chooseOption(userEvent, 'Результатів на сторінці', '48')

  expect(push).toHaveBeenCalledWith(
    '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&pageSize=48&language=uk',
  )
})

it('an explicit size 36 is asked for and kept in page links; 12 drops it from the address', async () => {
  apiRequest.mockResolvedValue(response({ page: 2, pageSize: 36, hasMore: true }))
  renderAt('q=Тигролови&language=uk&page=2&pageSize=36')
  await screen.findByRole('link', { name: 'Тигролови' })

  expect(apiRequest).toHaveBeenCalledWith(
    '/catalog/discover?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=2&pageSize=36&scope=CIRCLE&availability=AVAILABLE&language=uk&translation=ANY',
    expect.any(Object),
  )
  expect(screen.getByRole('link', { name: 'Сторінка 3' })).toHaveAttribute(
    'href',
    '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=3&pageSize=36&language=uk',
  )

  await chooseOption(userEvent, 'Результатів на сторінці', '12')

  expect(push).toHaveBeenCalledWith(
    '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&language=uk',
  )
})

it.each([
  { page: '3', pageSize: '10' },
  { page: '3', pageSize: '20' },
  { page: '3', pageSize: '50' },
  { page: 'abc', pageSize: '24' },
])(
  'an invalid address page=$page&pageSize=$pageSize is replaced by page 1 of 12, query and filters kept, and never asked for',
  async ({ page, pageSize }) => {
    apiRequest.mockImplementation((path: string) => {
      const asked = new URLSearchParams(path.split('?')[1] ?? '')

      return Promise.resolve(response({ page: Number(asked.get('page')), hasMore: true }))
    })
    renderAt(
      `q=Тигролови&language=uk&availability=ANY&scope=CIRCLE&page=${page}&pageSize=${pageSize}`,
    )

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&availability=ANY&language=uk',
      ),
    )
    expect(push).not.toHaveBeenCalled()

    const discover = () =>
      apiRequest.mock.calls
        .map(([path]: [string]) => path)
        .filter((path: string) => path.startsWith('/catalog/discover?'))
        .map((path: string) => new URLSearchParams(path.split('?')[1]))

    // The first request is already the corrected page 1 with the query and the filters; only the
    // pages ahead of it follow.
    await waitFor(() =>
      expect(discover().map((asked) => asked.get('page'))).toEqual(['1', '2', '3']),
    )
    for (const asked of discover()) {
      expect(asked.get('pageSize')).toBe('12')
      expect(asked.get('q')).toBe('Тигролови')
      expect(asked.get('availability')).toBe('ANY')
      expect(asked.get('language')).toBe('uk')
    }
  },
)

it('the legacy ALL scope hides the filters and never sends them', async () => {
  renderAt('q=Тигролови&scope=ALL')

  await screen.findByRole('link', { name: 'Тигролови' })
  expect(screen.queryByLabelText('Доступність')).not.toBeInTheDocument()
  expect(apiRequest).toHaveBeenCalledWith(expect.stringMatching(/scope=ALL$/), expect.any(Object))
})

it('normalises an invalid filter value in the address', async () => {
  renderAt('availability=NOPE')

  await waitFor(() => expect(replace).toHaveBeenCalledWith('/catalog'))
})

it('requests a copy right from the result without searching again', async () => {
  renderAt('q=Тигролови')
  await userEvent.click(await screen.findByRole('button', { name: 'Попросити' }))
  await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

  await waitFor(() =>
    expect(apiRequest).toHaveBeenCalledWith('/loans', {
      method: 'POST',
      body: { copyId: 'copy-1' },
    }),
  )
  // The list is refreshed once so `canRequest` can flip.
  await waitFor(() =>
    expect(
      apiRequest.mock.calls.filter(([p]: [string]) => p.startsWith('/catalog/discover')),
    ).toHaveLength(2),
  )
})

describe('BS-134: the grid and the two pages ahead', () => {
  /** Discovery pages asked, in order, with the signal each request carried. */
  function discoverCalls(): { page: number; availability: string | null; signal: AbortSignal }[] {
    return apiRequest.mock.calls
      .filter(([path]: [string]) => path.startsWith('/catalog/discover?'))
      .map(([path, options]: [string, { signal: AbortSignal }]) => {
        const query = new URLSearchParams(path.split('?')[1])

        return {
          page: Number(query.get('page')),
          availability: query.get('availability'),
          signal: options.signal,
        }
      })
  }

  const pagesAsked = () => discoverCalls().map((call) => call.page)

  /** Five pages of results; a request for `hold` never answers until it is aborted. */
  function pagesOfFive(hold?: (page: number) => boolean) {
    apiRequest.mockImplementation((path: string, options: { signal: AbortSignal }) => {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'))

      if (hold?.(page) === true) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }

      return Promise.resolve(response({ page, hasMore: page < 5 }))
    })
  }

  it('shows the results as the shared result grid', async () => {
    renderAt()

    const card = (await screen.findByRole('link', { name: 'Тигролови' })).closest('li')

    expect(card?.closest('.result-grid')).not.toBeNull()
  })

  it('loads 2 and then 3 in the background; on page 2 it reuses them and only asks 4', async () => {
    pagesOfFive()
    // Keeps what it loads, as the app's client does for minutes (the test default collects at once).
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })

    parameters = new URLSearchParams('q=Тигролови')

    const view = render(withQueryClient(<CatalogPage />, queryClient))

    await waitFor(() => {
      expect(pagesAsked()).toEqual([1, 2, 3])
    })

    parameters = new URLSearchParams('q=Тигролови&page=2')
    view.rerender(withQueryClient(<CatalogPage />, queryClient))

    expect(screen.getByRole('link', { name: 'Сторінка 2, поточна' })).toBeInTheDocument()
    await waitFor(() => {
      expect(pagesAsked()).toEqual([1, 2, 3, 4])
    })
  })

  it('stops at the proven end', async () => {
    renderAt()

    await screen.findByRole('link', { name: 'Тигролови' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pagesAsked()).toEqual([1])
  })

  it('a filter change cancels the old queue and starts again from page 1', async () => {
    pagesOfFive((page) => page === 2)

    const queryClient = new QueryClient()

    parameters = new URLSearchParams('q=Тигролови')

    const view = render(withQueryClient(<CatalogPage />, queryClient))

    await waitFor(() => {
      expect(pagesAsked()).toEqual([1, 2])
    })

    const [, oldPage2] = discoverCalls()

    parameters = new URLSearchParams('q=Тигролови&availability=ANY')
    view.rerender(withQueryClient(<CatalogPage />, queryClient))

    await waitFor(() => {
      expect(
        discoverCalls()
          .filter((call) => call.availability === 'ANY')
          .map((call) => call.page),
      ).toEqual([1, 2])
    })
    expect(oldPage2?.signal.aborted).toBe(true)
  })
})
