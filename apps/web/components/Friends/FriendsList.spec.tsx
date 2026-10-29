/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Friend, FriendRequest, PublicUser } from '@bookswap/shared'
import { FriendsList } from './FriendsList'

const friendUser: PublicUser = {
  id: 'friend-1',
  displayName: 'Олена Коваль',
  handle: 'olena',
  avatarUrl: null,
}

const incomingUser: PublicUser = {
  id: 'incoming-1',
  displayName: 'Марко Левченко',
  handle: 'marko',
  avatarUrl: null,
}

const outgoingUser: PublicUser = {
  id: 'outgoing-1',
  displayName: 'Ірина Бондар',
  handle: 'iryna',
  avatarUrl: null,
}

const friend: Friend = {
  user: friendUser,
  friendsSince: '2026-08-20T10:00:00.000Z',
}

const incoming: FriendRequest = {
  id: 'request-incoming',
  user: incomingUser,
  createdAt: '2026-08-24T10:00:00.000Z',
}

const outgoing: FriendRequest = {
  id: 'request-outgoing',
  user: outgoingUser,
  createdAt: '2026-08-23T10:00:00.000Z',
}

function renderList({
  friends = [],
  incomingRequests = [],
  outgoingRequests = [],
}: {
  friends?: Friend[]
  incomingRequests?: FriendRequest[]
  outgoingRequests?: FriendRequest[]
} = {}) {
  const handlers = {
    onRespond: jest.fn(),
    onCancelRequest: jest.fn(),
    onRemoveFriend: jest.fn(),
    onBlockFriend: jest.fn(),
  }

  render(
    <FriendsList
      friends={friends}
      incoming={incomingRequests}
      outgoing={outgoingRequests}
      busyKey={undefined}
      {...handlers}
    />,
  )

  return handlers
}

describe('FriendsList', () => {
  it('does not render empty request sections', () => {
    renderList()

    expect(screen.queryByText('Нові запити')).not.toBeInTheDocument()
    expect(screen.queryByText('Надіслані запити')).not.toBeInTheDocument()
    expect(screen.getByText('Тут поки нікого')).toBeInTheDocument()
  })

  it('points an empty friends list to the people search', () => {
    renderList()

    const link = screen.getByRole('link', { name: 'Знайдіть людину' })

    expect(link).toHaveAttribute('href', '/friends/search')
    expect(link.closest('p')).toHaveTextContent('Знайдіть людину й надішліть запит у друзі.')
  })

  it('shows incoming requests first with compact accept and decline actions', async () => {
    const user = userEvent.setup()
    const handlers = renderList({
      friends: [friend],
      incomingRequests: [incoming],
      outgoingRequests: [outgoing],
    })

    expect(screen.getByRole('heading', { name: 'Нові запити' })).toBeInTheDocument()
    expect(screen.getByText('Надіслані запити')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Прийняти запит від Марко Левченко' }))
    expect(handlers.onRespond).toHaveBeenCalledWith('request-incoming', 'accept')

    await user.click(screen.getByRole('button', { name: 'Відхилити запит від Марко Левченко' }))
    expect(handlers.onRespond).toHaveBeenCalledWith('request-incoming', 'decline')
  })

  it('keeps destructive friend actions behind the row menu trigger', () => {
    renderList({ friends: [friend] })

    expect(screen.queryByText('Видалити з друзів')).not.toBeInTheDocument()
    expect(screen.queryByText('Заблокувати')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Дії з другом Олена Коваль' })).toBeInTheDocument()
  })
})
