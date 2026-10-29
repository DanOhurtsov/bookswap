/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionState } from '@/app/lib/use-session'
import { FriendsSessionBoundary } from './FriendsSessionBoundary'

jest.mock('@/app/lib/use-session', () => ({
  useSession: jest.fn(),
}))

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
}))

jest.mock('@/components/Friends/FriendsPageContent', () => ({
  FriendsPageContent: () => <div>Готовий список друзів</div>,
}))

const { useSession: mockUseSession } = jest.requireMock<{ useSession: jest.Mock }>(
  '@/app/lib/use-session',
)
const { useRouter: mockUseRouter } = jest.requireMock<{ useRouter: jest.Mock }>('next/navigation')

const reload = jest.fn()
const replace = jest.fn()

function setSessionState(state: SessionState): void {
  mockUseSession.mockReturnValue({ state, reload, setUser: jest.fn() })
}

beforeEach(() => {
  reload.mockReset()
  replace.mockReset()
  mockUseRouter.mockReturnValue({ replace })
})

describe('FriendsSessionBoundary', () => {
  it('renders a dedicated loading state', () => {
    setSessionState({ status: 'loading' })

    render(<FriendsSessionBoundary />)

    expect(screen.getByLabelText('Перевіряю сесію')).toBeInTheDocument()
  })

  it('renders a retryable session error', async () => {
    const user = userEvent.setup()
    setSessionState({ status: 'error', message: 'Сесію не завантажено' })

    render(<FriendsSessionBoundary />)

    expect(screen.getByRole('alert')).toHaveTextContent('Сесію не завантажено')
    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('redirects guests without rendering authenticated content', async () => {
    setSessionState({ status: 'guest' })
    window.history.replaceState(null, '', '/friends?tab=requests#incoming')

    render(<FriendsSessionBoundary />)

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        '/login?returnTo=%2Ffriends%3Ftab%3Drequests%23incoming',
      ),
    )
    // BS-146: the link offered while redirecting comes back here too.
    expect(screen.getByRole('link', { name: 'Увійти зараз' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Ffriends%3Ftab%3Drequests%23incoming',
    )
    expect(screen.queryByText('Готовий список друзів')).not.toBeInTheDocument()
  })

  it('renders the friends content only for an authenticated session', () => {
    setSessionState({
      status: 'authenticated',
      user: {
        id: 'me',
        email: 'me@example.com',
        displayName: 'Ярина',
        handle: 'reader',
        city: null,
        avatarUrl: null,
        bio: null,
        emailVerified: true,
        libraryVisibility: 'FRIENDS',
        showHolderNames: true,
        friendsOfFriendsAccess: false,
        loanRequestsPaused: false,
        defaultLoanTermDays: null,
        ownerDueReminders: true,
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    })

    render(<FriendsSessionBoundary />)

    expect(screen.getByText('Готовий список друзів')).toBeInTheDocument()
    // The full people search is one step from the friends lists, next to the page title — the
    // page's only action there.
    expect(screen.getByRole('link', { name: 'Знайти людей' })).toHaveAttribute(
      'href',
      '/friends/search',
    )
    expect(screen.queryByRole('button', { name: 'Додати друга' })).not.toBeInTheDocument()
  })
})
