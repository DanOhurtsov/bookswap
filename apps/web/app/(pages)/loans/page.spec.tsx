/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionState } from '@/app/lib/use-session'
import LoansPage from './page'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
const mockPush = jest.fn()
let mockParameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockParameters,
}))

const SIGNED_IN: Extract<SessionState, { status: 'authenticated' }> = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

let mockSession: SessionState = SIGNED_IN

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const requestedPaths = () => apiRequest.mock.calls.map(([path]) => path as string)

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue({ loans: [] })
  mockReplace.mockReset()
  mockPush.mockReset()
  mockParameters = new URLSearchParams()
  mockSession = SIGNED_IN
})

describe('LoansPage: вкладки «Мої книжки» / «Я позичаю» (BS-87)', () => {
  it('без ?role= обрано «Мої книжки», і панель показує порожній стан власника', async () => {
    render(<LoansPage />)

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Мої книжки',
      'Я позичаю',
    ])
    expect(screen.getByRole('tab', { name: 'Мої книжки' })).toHaveAttribute('aria-selected', 'true')
    expect(
      await screen.findByText(/Вашими книжками поки ніхто не цікавився/, {
        selector: '[role="tabpanel"] *',
      }),
    ).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans?role=owner'])
  })

  it('?role=borrower відкриває «Я позичаю» і запитує саме цей бік', async () => {
    mockParameters = new URLSearchParams('role=borrower')

    render(<LoansPage />)

    expect(screen.getByRole('tab', { name: 'Я позичаю' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText(/Ви поки нічого не позичали й не просили/)).toBeVisible()
    expect(requestedPaths()).toEqual(['/loans?role=borrower'])
  })

  it('вкладка міняє ?role= через replace і зберігає решту параметрів', async () => {
    mockParameters = new URLSearchParams('status=REQUESTED')

    render(<LoansPage />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    await userEvent.click(screen.getByRole('tab', { name: 'Я позичаю' }))

    expect(mockReplace).toHaveBeenCalledWith('/loans?status=REQUESTED&role=borrower')
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('LoansPage: вхід у «Гостьові позики» (BS-104)', () => {
  it('за ввімкненого guestLoans посилання стоїть над вкладками й веде на /loans/guest', async () => {
    mockSession = { ...SIGNED_IN, features: { guestLoans: true } }

    render(<LoansPage />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    expect(screen.getByRole('link', { name: 'Гостьові позики' })).toHaveAttribute(
      'href',
      '/loans/guest',
    )
  })

  it.each([
    ['guestLoans=false', { guestLoans: false }],
    ['features unknown', undefined],
  ])('без прапора (%s) посилання немає', async (_name, features) => {
    mockSession = { ...SIGNED_IN, ...(features === undefined ? {} : { features }) }

    render(<LoansPage />)
    await screen.findByText(/Вашими книжками поки ніхто не цікавився/)

    expect(screen.queryByRole('link', { name: 'Гостьові позики' })).not.toBeInTheDocument()
  })
})
