/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
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

const menuTrigger = () => screen.getByRole('button', { name: 'Відкрити меню навігації' })

/** jsdom does not navigate; the menu reacts to the click itself. */
function keepPage(item: HTMLElement): HTMLElement {
  item.addEventListener('click', (event) => event.preventDefault())
  return item
}

const SEARCH_NAME = /пошук|знайти|шукати|search/i

/** The header offers no way into a search: no landmark, field, results or control for one. */
function expectNoSearch() {
  expect(screen.queryByRole('search')).not.toBeInTheDocument()
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: SEARCH_NAME })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: SEARCH_NAME })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: SEARCH_NAME })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: SEARCH_NAME })).not.toBeInTheDocument()
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
    expectNoSearch()
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
      expectNoSearch()
    },
  )

  it('renders authenticated navigation and the profile menu', () => {
    renderState({ status: 'authenticated', user })

    expect(screen.getByRole('link', { name: 'Головна' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Каталог' })).toHaveAttribute('href', '/catalog')
    expect(screen.getByRole('link', { name: 'Моя бібліотека' })).toHaveAttribute('href', '/library')
    // BS-136: moved here from the profile menu (NavBarAvatar.spec.tsx).
    expect(screen.getAllByRole('link', { name: 'Друзі' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Друзі' })).toHaveAttribute('href', '/friends')
    // Sections of «Моя бібліотека» now, reached through its own navigation.
    expect(screen.queryByRole('link', { name: 'Вішлист' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Позичання' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Історія' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    // The theme toggle lives inside the profile menu for signed-in users.
    expect(screen.queryByRole('button', { name: 'Theme' })).not.toBeInTheDocument()
    expect(screen.getByTestId('profile-menu')).toHaveTextContent('Reader One')
    expect(screen.queryByRole('link', { name: 'Увійти' })).not.toBeInTheDocument()
    expectNoSearch()
  })

  it.each([
    ['guestLoans=true', { guestLoans: true }],
    ['guestLoans=false', { guestLoans: false }],
  ])('offers no people search to a signed-in person (%s)', (_name, features) => {
    renderState({ status: 'authenticated', user, features })

    expectNoSearch()
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
    [
      'guestLoans=true',
      { guestLoans: true },
      ['Головна', 'Каталог', 'Моя бібліотека', 'Друзі', 'Контакти'],
    ],
    ['features unknown', undefined, ['Головна', 'Каталог', 'Моя бібліотека', 'Друзі']],
  ])(
    'the compact menu (%s) offers the same links as the inline row',
    async (_name, features, labels) => {
      renderState({
        status: 'authenticated',
        user,
        ...(features === undefined ? {} : { features }),
      })

      expect(
        within(screen.getByRole('navigation'))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(labels)

      await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

      const items = await screen.findAllByRole('menuitem')

      expect(items.map((item) => item.textContent)).toEqual(labels)
      expect(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Моя бібліотека' }),
      ).toHaveAttribute('href', '/library')
      expect(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Друзі' }),
      ).toHaveAttribute('href', '/friends')
      expectNoSearch()
    },
  )

  it.each([
    '/library',
    '/library/copy-1',
    '/library/imports',
    '/loans',
    '/loans/guest',
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

  it.each(['/friends', '/friends/search'])(
    'on %s «Друзі» is the current page, in the row and in the menu',
    async (pathname) => {
      mockPathname = pathname
      renderState({ status: 'authenticated', user, features: { guestLoans: true } })

      const friends = screen.getByRole('link', { name: 'Друзі' })

      expect(friends).toHaveAttribute('aria-current', 'page')
      // The visible mark of the current page is the `link-underline` rule for `aria-current`.
      expect(friends).toHaveClass('link-underline')
      expect(
        screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
      ).toHaveLength(1)

      await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

      expect(await screen.findByRole('menuitem', { name: 'Друзі' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      expect(
        screen.getAllByRole('menuitem').filter((item) => item.hasAttribute('aria-current')),
      ).toHaveLength(1)
    },
  )

  it.each([
    '/',
    '/catalog',
    '/friends-other',
    '/friendship',
    '/users/user-2/library',
    '/users/user-2/friends',
    '/copies/copy-1/history',
  ])('on %s no header entry is marked current', async (pathname) => {
    mockPathname = pathname
    renderState({ status: 'authenticated', user, features: { guestLoans: true } })

    expect(screen.getByRole('link', { name: 'Моя бібліотека' })).not.toHaveAttribute('aria-current')
    expect(
      screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
    ).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Відкрити меню навігації' }))

    expect(await screen.findByRole('menuitem', { name: 'Моя бібліотека' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(
      screen.getAllByRole('menuitem').filter((item) => item.hasAttribute('aria-current')),
    ).toHaveLength(0)
  })

  it('the compact menu is reachable with Tab and lets the arrow keys and Enter choose «Друзі»', async () => {
    const events = userEvent.setup()
    renderState({ status: 'authenticated', user })

    await events.tab()
    expect(menuTrigger()).toHaveFocus()

    await events.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    const friends = keepPage(within(menu).getByRole('menuitem', { name: 'Друзі' }))

    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Головна' })).toHaveFocus()
    })
    await events.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(friends).toHaveFocus()

    await events.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('choosing a link in the compact menu closes it', async () => {
    const events = userEvent.setup()
    renderState({ status: 'authenticated', user })

    await events.click(menuTrigger())
    const menu = await screen.findByRole('menu')

    await events.click(keepPage(within(menu).getByRole('menuitem', { name: 'Друзі' })))

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('Escape closes the compact menu and returns focus to its button', async () => {
    const events = userEvent.setup()
    renderState({ status: 'authenticated', user })

    await events.click(menuTrigger())
    await screen.findByRole('menu')

    await events.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(menuTrigger()).toHaveFocus()
  })
})
