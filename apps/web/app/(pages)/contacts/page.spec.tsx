/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { SessionState } from '@/app/lib/use-session'
import ContactsPage from './page'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}))

let mockState: SessionState = { status: 'loading' }

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: mockState }),
}))

jest.mock('../../lib/use-session', () => ({
  useSession: () => ({ state: mockState }),
}))

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(() => Promise.resolve({ contacts: [] })) }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const user = {
  id: 'user-1',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Reader',
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS' as const,
  showHolderNames: false,
  createdAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('ContactsPage (GATE3)', () => {
  it.each<[string, SessionState]>([
    ['guestLoans=false', { status: 'authenticated', user, features: { guestLoans: false } }],
    ['features unknown', { status: 'authenticated', user }],
  ])('%s: no contacts UI and no contact API call', (_name, state) => {
    mockState = state
    render(<ContactsPage />)

    expect(screen.getByText('Сторінку не знайдено')).toBeInTheDocument()
    expect(screen.queryByText(/Лише синтетичні тестові дані/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Додати контакт' })).not.toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('guestLoans=true: banner, form only after the list loads', async () => {
    mockState = { status: 'authenticated', user, features: { guestLoans: true } }
    render(<ContactsPage />)

    expect(screen.getByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Додати контакт' })).not.toBeInTheDocument()
    expect(await screen.findByText('Контактів поки немає.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати контакт' })).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith('/me/external-borrowers', expect.anything())
  })

  it('a guest is sent to login and nothing is requested', () => {
    mockState = { status: 'guest' }
    render(<ContactsPage />)

    expect(mockReplace).toHaveBeenCalledWith('/login')
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('a session error is shown and nothing is requested', () => {
    mockState = { status: 'error', message: 'Сесія недоступна' }
    render(<ContactsPage />)

    expect(screen.getByRole('alert')).toHaveTextContent('Сесія недоступна')
    expect(apiRequest).not.toHaveBeenCalled()
  })
})
