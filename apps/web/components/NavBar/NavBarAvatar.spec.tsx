/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Me } from '@bookswap/shared'
import { NavBarAvatar } from './NavBarAvatar'

// Logout through this menu is covered against the real session context in
// app/lib/session-lifecycle.spec.tsx.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ setGuest: jest.fn() }),
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

const trigger = () => screen.getByRole('button', { name: 'Відкрити меню профілю: Reader One' })

async function openMenu() {
  const events = userEvent.setup()
  render(<NavBarAvatar user={user} />)
  await events.click(trigger())

  return { events, menu: await screen.findByRole('menu') }
}

/** jsdom does not navigate; the menu reacts to the click itself. */
function keepPage(item: HTMLElement): HTMLElement {
  item.addEventListener('click', (event) => event.preventDefault())
  return item
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.dataset.theme = 'light'
})

describe('NavBarAvatar', () => {
  it('lists Профіль, Друзі, then the theme toggle and Вийти', async () => {
    const { menu } = await openMenu()

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Профіль', 'Друзі', 'Темна тема', 'Вийти'])
    expect(
      within(menu).queryByRole('menuitem', { name: /пошук|знайти|search/i }),
    ).not.toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Профіль' })).toHaveAttribute(
      'href',
      '/profile',
    )
    // BS-145: the separate reading list is gone; the counts are on the home page.
    expect(within(menu).queryByRole('menuitem', { name: 'Список читання' })).not.toBeInTheDocument()
  })

  it('offers exactly one «Друзі» entry, a link to /friends', async () => {
    const { menu } = await openMenu()

    const friends = within(menu).getAllByRole('menuitem', { name: 'Друзі' })

    expect(friends).toHaveLength(1)
    expect(friends[0]).toHaveAttribute('href', '/friends')
    expect(friends[0]?.tagName).toBe('A')
  })

  it('choosing «Друзі» closes the menu', async () => {
    const { events, menu } = await openMenu()

    await events.click(keepPage(within(menu).getByRole('menuitem', { name: 'Друзі' })))

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('reaches «Друзі» with the arrow keys and chooses it with Enter', async () => {
    const events = userEvent.setup()
    render(<NavBarAvatar user={user} />)

    trigger().focus()
    await events.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    const friends = keepPage(within(menu).getByRole('menuitem', { name: 'Друзі' }))

    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Профіль' })).toHaveFocus()
    })
    await events.keyboard('{ArrowDown}')
    expect(friends).toHaveFocus()

    await events.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('Escape closes the menu and returns focus to the avatar', async () => {
    const { events } = await openMenu()

    await events.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(trigger()).toHaveFocus()
  })

  it('the theme toggle switches the theme and keeps the menu open', async () => {
    const { events, menu } = await openMenu()

    await events.click(within(menu).getByRole('menuitem', { name: 'Темна тема' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Світла тема' })).toBeInTheDocument()
  })
})
