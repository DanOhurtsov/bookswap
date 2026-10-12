/** @jest-environment jsdom */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Me } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import { NavContent } from './NavBarContent'

let mockPathname = '/'

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

jest.mock('@/components/ThemeToggle', () => ({
  ThemeToggleButton: () => <button type="button">Theme</button>,
}))

jest.mock('@/components/NavBar/NavBarAvatar', () => ({
  NavBarAvatar: ({ user }: { user: Me }) => (
    <span data-testid="profile-menu">{user.displayName}</span>
  ),
}))

jest.mock('@/components/NavBar/NavBarNotifications', () => ({
  NavBarNotifications: () => <button type="button">Notifications</button>,
}))

// Covered on its own, header placement included, in features/user-search.
jest.mock('@/features/user-search/index.client', () => ({
  UserSearch: () => <div role="search" aria-label="People search" />,
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

beforeEach(() => {
  mockPathname = '/'
})

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
      expect(screen.queryByRole('link', { name: 'Вішлист' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('profile-menu')).not.toBeInTheDocument()
    },
  )

  it('renders authenticated navigation and the profile menu', () => {
    renderState({ status: 'authenticated', user })

    expect(screen.getByRole('link', { name: 'Головна' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Каталог' })).toHaveAttribute('href', '/catalog')
    expect(screen.getByRole('link', { name: 'Моя бібліотека' })).toHaveAttribute('href', '/library')
    // Reached through the profile menu now (NavBarAvatar.spec.tsx).
    expect(screen.queryByRole('link', { name: 'Друзі' })).not.toBeInTheDocument()
    // Sections of «Моя бібліотека» now, reached through its own navigation.
    expect(screen.queryByRole('link', { name: 'Вішлист' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Позичання' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Історія' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    // The theme toggle lives inside the profile menu for signed-in users.
    expect(screen.queryByRole('button', { name: 'Theme' })).not.toBeInTheDocument()
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

  it.each([
    ['guestLoans=true', { guestLoans: true }, ['Головна', 'Каталог', 'Моя бібліотека', 'Контакти']],
    ['features unknown', undefined, ['Головна', 'Каталог', 'Моя бібліотека']],
  ])(
    'the compact menu (%s) offers the same links as the inline row',
    async (_name, features, labels) => {
      renderState({
        status: 'authenticated',
        user,
        ...(features === undefined ? {} : { features }),
      })

      await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

      const items = await screen.findAllByRole('menuitem')

      expect(items.map((item) => item.textContent)).toEqual(labels)
      expect(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Моя бібліотека' }),
      ).toHaveAttribute('href', '/library')
    },
  )

  it.each([
    '/library',
    '/library/copy-1',
    '/library/imports',
    '/loans',
    '/loans/guest',
    '/history',
    '/wishlist',
  ])('on %s «Моя бібліотека» is the current page, in the row and in the menu', async (pathname) => {
    mockPathname = pathname
    renderState({ status: 'authenticated', user, features: { guestLoans: true } })

    expect(screen.getByRole('link', { name: 'Моя бібліотека' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
    ).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

    expect(await screen.findByRole('menuitem', { name: 'Моя бібліотека' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getAllByRole('menuitem').filter((item) => item.hasAttribute('aria-current')),
    ).toHaveLength(1)
  })

  it.each(['/', '/catalog', '/friends', '/users/user-2/library', '/copies/copy-1/history'])(
    'on %s no header entry is marked current',
    async (pathname) => {
      mockPathname = pathname
      renderState({ status: 'authenticated', user, features: { guestLoans: true } })

      expect(screen.getByRole('link', { name: 'Моя бібліотека' })).not.toHaveAttribute(
        'aria-current',
      )
      expect(
        screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
      ).toHaveLength(0)

      await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

      expect(await screen.findByRole('menuitem', { name: 'Моя бібліотека' })).not.toHaveAttribute(
        'aria-current',
      )
    },
  )
})
