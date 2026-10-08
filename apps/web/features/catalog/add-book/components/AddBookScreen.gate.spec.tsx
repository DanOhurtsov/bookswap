/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { withQueryClient } from '@/app/lib/test-query-client'
import { AddBookScreen } from './AddBookScreen'

/**
 * Ворота сесії: нічого, що потребує користувача, не стартує, поки його немає, — ні пошукові запити,
 * ні виправлення адреси, ні ручна форма. Решту поведінки екрана перевіряє `AddBookScreen.spec.tsx`.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('../lib/load-barcode-scanner-panel', () => ({
  loadBarcodeScannerPanel: () => Promise.resolve(() => null),
}))

type MockSession =
  | { status: 'loading' }
  | { status: 'guest' }
  | {
      status: 'authenticated'
      user: { id: string; displayName: string; email: string; libraryVisibility: 'FRIENDS' }
    }

const AUTHENTICATED: MockSession = {
  status: 'authenticated',
  user: { id: 'me', displayName: 'Тест', email: 't@example.com', libraryVisibility: 'FRIENDS' },
}

let mockSession: MockSession = AUTHENTICATED
let mockSearchParams = new URLSearchParams()
const mockRouter = { push: jest.fn(), replace: jest.fn() }

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: mockSession, reload: jest.fn(), setUser: jest.fn() }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeEach(() => {
  jest.clearAllMocks()
  window.sessionStorage.clear()
  mockSession = AUTHENTICATED
  mockSearchParams = new URLSearchParams('q=кобзар')
  mockApiRequest.mockImplementation((path: string) => {
    if (path.startsWith('/me/library/add-search/external?')) {
      return Promise.resolve({
        items: [],
        sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        page: 1,
        pageSize: 10,
        more: 'NO',
        complete: true,
      })
    }
    if (path.startsWith('/me/library/add-search?')) {
      return Promise.resolve({ items: [], page: 1, pageSize: 10, total: 0, hasMore: false })
    }

    return Promise.reject(new Error(`Неочікуваний запит ${path}`))
  })
})

const renderScreen = () => render(withQueryClient(<AddBookScreen />))

describe('ворота сесії', () => {
  it('поки сесію перевіряють: повідомлення, жодних запитів і жодних переходів', () => {
    mockSession = { status: 'loading' }
    renderScreen()

    expect(screen.getByText('Перевіряю сесію…')).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })

  it('гість: повідомлення, перехід на вхід і жодних запитів', () => {
    mockSession = { status: 'guest' }
    renderScreen()

    expect(screen.getByText('Потрібен вхід. Переадресовую…')).toBeInTheDocument()
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
    expect(mockRouter.replace).toHaveBeenCalledWith('/login')
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('гість із зіпсованою сторінкою в адресі: адресу не чіпають, лише ведуть на вхід', () => {
    mockSession = { status: 'guest' }
    mockSearchParams = new URLSearchParams('q=кобзар&page=abc')
    renderScreen()

    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
    expect(mockRouter.replace).toHaveBeenCalledWith('/login')
  })

  it('автентифікований: екран пошуку й запит за адресою', async () => {
    renderScreen()

    expect(
      await screen.findByRole('textbox', { name: 'Назва, автор або ISBN' }),
    ).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledWith(
      expect.stringContaining('/me/library/add-search?'),
      expect.anything(),
    )
  })

  it('автентифікований із зіпсованою сторінкою: адресу виправляють у будь-якому режимі', () => {
    mockSearchParams = new URLSearchParams('q=кобзар&page=abc')
    renderScreen()

    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/catalog/new?q=%D0%BA%D0%BE%D0%B1%D0%B7%D0%B0%D1%80',
    )
  })

  it('ручний режим не шле пошукових запитів, навіть коли в адресі лишився q', async () => {
    mockSearchParams = new URLSearchParams('mode=manual&q=кобзар')
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Додати книжку вручну' })).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })
})
