/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type {
  WishlistResponse,
  Work,
  WorkAuthor,
  WorkDetailResponse,
  WorkHistoryResponse,
} from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import WorkPage from './page'

/**
 * §6.3 і DoD 7h: «web виконує редирект на канонічний URL».
 *
 * Мокається саме `lib/api`, а не `useWork` — інакше під тестом лишилася б сама
 * лише `useEffect` у сторінці, а розбір ознаки переміщення (`redirected` →
 * `canonicalWorkId`) не перевірявся б узагалі. Так під тестом увесь ланцюг:
 * відповідь клієнта API → хук → заміна адреси.
 */

// Holders have their own component tests; here the work's own fetch sequence is the subject.
jest.mock('@/features/network/index.client', () => ({ HoldersPanel: () => null }))

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'me', name: 'Тест', email: 't@example.com' } },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

const replace = jest.fn()
let routeWorkId = 'work-old'

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: routeWorkId }),
  useRouter: () => ({ push: jest.fn(), replace }),
}))

const { apiRequest: mockApiRequest, apiRequestWithRedirect: mockApiRequestWithRedirect } =
  jest.requireMock<{ apiRequest: jest.Mock; apiRequestWithRedirect: jest.Mock }>('@/app/lib/api')

function work(id: string, title: string): Work {
  return {
    id,
    title,
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
  }
}

const authors: WorkAuthor[] = [
  { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 },
]

function detail(id: string, title: string): WorkDetailResponse {
  return { work: work(id, title), authors, translations: [], editions: [] }
}

function history(id: string, title: string): WorkHistoryResponse {
  return { work: work(id, title), authors, entries: [] }
}

const emptyWishlist: WishlistResponse = { items: [] }

/** Решта запитів сторінки — історія твору й вішлист — до предмета тесту не належать. */
function stubSideRequests(): void {
  mockApiRequest.mockImplementation((path: string) => {
    if (path.startsWith('/works/')) return Promise.resolve(history('work-new', 'Канонічний'))

    return Promise.resolve(emptyWishlist)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  routeWorkId = 'work-old'
  stubSideRequests()
})

describe('Сторінка твору: канонічний URL', () => {
  it('дані приїхали через 301 — адреса замінюється на канонічну', async () => {
    mockApiRequestWithRedirect.mockResolvedValue({
      data: detail('work-new', 'Канонічний'),
      redirected: true,
    })

    render(withQueryClient(<WorkPage />))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/works/work-new')
    })

    // Дані показуються канонічні, а не порожня сторінка змерженого твору.
    expect(await screen.findByRole('heading', { name: 'Канонічний' })).toBeInTheDocument()
  })

  it('звичайне читання без редиректу адресу не чіпає', async () => {
    routeWorkId = 'work-new'
    mockApiRequestWithRedirect.mockResolvedValue({
      data: detail('work-new', 'Канонічний'),
      redirected: false,
    })

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('heading', { name: 'Канонічний' })).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})
