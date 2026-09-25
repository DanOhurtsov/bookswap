/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { CatalogDiscoveryResponse, CatalogDiscoveryResult } from '@bookswap/shared'
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
    },
  ],
}

function response(overrides: Partial<CatalogDiscoveryResponse> = {}): CatalogDiscoveryResponse {
  return {
    results: [candidate],
    page: 1,
    pageSize: 10,
    scope: 'CIRCLE',
    total: 1,
    hasMore: false,
    ...overrides,
  }
}

function renderAt(search = 'q=Тигролови') {
  parameters = new URLSearchParams(search)
  return render(<CatalogPage />)
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
  expect(screen.getByLabelText('Показувати книжки')).toHaveValue('CIRCLE')
  expect(apiRequest).toHaveBeenCalledWith(
    '/catalog/discover?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=1&pageSize=10&scope=CIRCLE',
    expect.any(Object),
  )
  expect(apiRequest.mock.calls.some(([path]: [string]) => path.includes('/external'))).toBe(false)
})

it('switches to all users, resetting the page and keeping its size', async () => {
  renderAt('q=Тигролови&page=3&pageSize=20')
  await userEvent.selectOptions(screen.getByLabelText('Показувати книжки'), 'ALL')

  expect(push).toHaveBeenCalledWith(
    '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&pageSize=20&scope=ALL',
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
  apiRequest.mockResolvedValue(response({ page: 2, pageSize: 20, hasMore: true }))
  renderAt('q=Тигролови&page=2&pageSize=20')

  expect(await screen.findByRole('link', { name: 'Тигролови' })).toBeInTheDocument()
  expect(screen.getByLabelText('Результатів на сторінці')).toHaveValue('20')
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
