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
  it('lists Профіль, then the theme toggle and Вийти', async () => {
    const { menu } = await openMenu()

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Профіль', 'Темна тема', 'Вийти'])
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

  it('offers no «Друзі» entry: it is in the header navigation now (BS-136)', async () => {
    const { menu } = await openMenu()

    expect(within(menu).queryByRole('menuitem', { name: 'Друзі' })).not.toBeInTheDocument()
    expect(menu.querySelector('a[href="/friends"]')).toBeNull()
  })

  it('choosing «Профіль» closes the menu', async () => {
    const { events, menu } = await openMenu()

    await events.click(keepPage(within(menu).getByRole('menuitem', { name: 'Профіль' })))

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('moves through the items with the arrow keys and chooses «Профіль» with Enter', async () => {
    const events = userEvent.setup()
    render(<NavBarAvatar user={user} />)

    trigger().focus()
    await events.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    const profile = keepPage(within(menu).getByRole('menuitem', { name: 'Профіль' }))

    await waitFor(() => {
      expect(profile).toHaveFocus()
    })
    await events.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Темна тема' })).toHaveFocus()
    await events.keyboard('{ArrowUp}')
    expect(profile).toHaveFocus()

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
