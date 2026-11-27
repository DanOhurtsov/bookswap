/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Friend } from '@bookswap/shared'
import { FriendsList } from './FriendsList'

function friendOf(id: string, displayName: string, handle: string): Friend {
  return {
    user: { id, displayName, handle, avatarUrl: null },
    friendsSince: '2026-08-20T10:00:00.000Z',
  }
}

const olena = friendOf('friend-1', 'Олена Коваль', 'olena')
const taras = friendOf('friend-2', 'Тарас Литвин', 'taras')

function renderList(friends: Friend[] = []) {
  const handlers = {
    onRemoveFriend: jest.fn(),
    onBlockFriend: jest.fn(),
    onFindFriends: jest.fn(),
  }

  render(<FriendsList friends={friends} busyKey={undefined} {...handlers} />)

  return handlers
}

describe('FriendsList', () => {
  it('points an empty friends list to «Знайти друзів»', async () => {
    const user = userEvent.setup()
    const handlers = renderList()

    expect(screen.getByRole('heading', { name: 'Тут поки нікого' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox', { name: 'Пошук серед друзів' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Знайти нових друзів' }))
    expect(handlers.onFindFriends).toHaveBeenCalledTimes(1)
  })

  it('makes the whole card a link to the friend’s library', () => {
    renderList([olena])

    const cards = screen.getByRole('list', { name: 'Мої друзі' })
    const link = within(cards).getByRole('link', { name: 'Олена Коваль' })

    expect(link).toHaveAttribute('href', '/u/olena')
    expect(within(cards).getByText('@olena')).toBeInTheDocument()
    expect(within(cards).getByText(/^Друзі з /)).toBeInTheDocument()
  })

  it('filters by name or nickname and says how many matched', async () => {
    const user = userEvent.setup()
    renderList([olena, taras])

    expect(screen.getByText('Показано 2 з 2 друзі')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Пошук серед друзів' }), '@tar')

    expect(screen.getByText('Знайдено: 1 друг')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Тарас Литвин' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Олена Коваль' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Очистити пошук' }))
    expect(screen.getByText('Показано 2 з 2 друзі')).toBeInTheDocument()
  })

  it('offers a reset and the people search when nobody matches', async () => {
    const user = userEvent.setup()
    const handlers = renderList([olena])

    await user.type(screen.getByRole('searchbox', { name: 'Пошук серед друзів' }), 'Марта')

    expect(screen.getByRole('heading', { name: 'Нікого не знайдено' })).toBeInTheDocument()
    expect(screen.getByText(/Серед друзів немає «Марта»/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Знайти нових друзів' }))
    expect(handlers.onFindFriends).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Скинути пошук' }))
    expect(screen.getByRole('link', { name: 'Олена Коваль' })).toBeInTheDocument()
  })

  it('keeps destructive friend actions behind the card menu trigger', async () => {
    const user = userEvent.setup()
    const handlers = renderList([olena])

    expect(screen.queryByText('Видалити з друзів')).not.toBeInTheDocument()
    expect(screen.queryByText('Заблокувати')).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Дії з другом Олена Коваль' })

    // The trigger goes along: the confirmation gives the focus back to it.
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: 'Видалити з друзів' }))
    expect(handlers.onRemoveFriend).toHaveBeenCalledWith(olena.user, trigger)

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: 'Заблокувати' }))
    expect(handlers.onBlockFriend).toHaveBeenCalledWith(olena.user, trigger)
  })
})
