/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { Me } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import { NavContent } from './NavBarContent'

jest.mock('@/components/ThemeSwitcher', () => ({
  ThemeSwitcher: () => <button type="button">Theme</button>,
}))

jest.mock('@/components/NavBar/NavBarAvatar', () => ({
  NavBarAvatar: ({ user }: { user: Me }) => (
    <span data-testid="profile-menu">{user.displayName}</span>
  ),
}))

jest.mock('@/components/NavBar/NavBarNotifications', () => ({
  NavBarNotifications: () => <button type="button">Notifications</button>,
}))

const user: Me = {
  id: 'user-1',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Reader One',
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: false,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function renderState(state: SessionState) {
  return render(<NavContent state={state} />)
}

describe('NavContent', () => {
  it('renders a non-interactive skeleton while the session is loading', () => {
    const { container } = renderState({ status: 'loading' })

    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('animate-pulse')
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it.each<SessionState>([{ status: 'guest' }, { status: 'error', message: 'Session unavailable' }])(
    'renders guest actions for the $status state',
    (state) => {
      renderState(state)

      expect(screen.getByRole('link', { name: 'Створити акаунт' })).toHaveAttribute(
        'href',
        '/register',
      )
      expect(screen.getByRole('link', { name: 'Увійти' })).toHaveAttribute('href', '/login')
      expect(screen.queryByTestId('profile-menu')).not.toBeInTheDocument()
    },
  )

  it('renders authenticated navigation and the profile menu', () => {
    renderState({ status: 'authenticated', user })

    expect(screen.getByRole('link', { name: 'Головна' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Друзі' })).toHaveAttribute('href', '/friends')
    expect(screen.getByRole('link', { name: 'Історія' })).toHaveAttribute('href', '/history')
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByTestId('profile-menu')).toHaveTextContent('Reader One')
    expect(screen.queryByRole('link', { name: 'Увійти' })).not.toBeInTheDocument()
  })
  it.each([
    ['guestLoans=true', { guestLoans: true }, true],
    ['guestLoans=false', { guestLoans: false }, false],
    ['features unknown', undefined, false],
  ])('contacts link (%s) visible: %s', (_name, features, visible) => {
    renderState({ status: 'authenticated', user, features })

    const link = screen.queryByRole('link', { name: 'Контакти' })

    if (visible) expect(link).toHaveAttribute('href', '/contacts')
    else expect(link).not.toBeInTheDocument()
  })
})
