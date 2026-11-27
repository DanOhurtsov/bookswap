import type { Friend, FriendRequest } from '@bookswap/shared'
import {
  friendsCount,
  friendsResultLabel,
  friendsTabHref,
  hasFriendsSearch,
  incomingRows,
  pendingIncomingCount,
  readFriendsTab,
  visibleFriends,
  type AnsweredRequest,
} from './friends-view'

function friendOf(id: string, displayName: string, handle: string, friendsSince: string): Friend {
  return { user: { id, displayName, handle, avatarUrl: null }, friendsSince }
}

function requestOf(id: string, createdAt: string): FriendRequest {
  return {
    id,
    user: { id: `user-${id}`, displayName: `Людина ${id}`, handle: id, avatarUrl: null },
    createdAt,
  }
}

const location = (search: string, hash = '') => ({ pathname: '/friends', search, hash })

describe('readFriendsTab', () => {
  it.each([
    ['', 'friends'],
    ['?tab=requests', 'requests'],
    ['?tab=find', 'find'],
    ['?tab=friends', 'friends'],
    ['?tab=unknown', 'friends'],
  ])('reads %s as %s', (search, tab) => {
    expect(readFriendsTab(new URLSearchParams(search))).toBe(tab)
  })
})

describe('friendsTabHref', () => {
  it('writes a tab and keeps the other parameters and the fragment', () => {
    expect(friendsTabHref(location('?from=mail', '#top'), 'requests')).toBe(
      '/friends?from=mail&tab=requests#top',
    )
  })

  it('writes «Мої друзі» as the bare address', () => {
    expect(friendsTabHref(location('?tab=find'), 'friends')).toBe('/friends')
    expect(friendsTabHref(location('?tab=find&from=mail'), 'friends')).toBe('/friends?from=mail')
  })
})

describe('visibleFriends', () => {
  const friends = [
    friendOf('1', 'Тарас Литвин', 'taras', '2026-10-03T10:00:00.000Z'),
    friendOf('2', 'Андрій Шевчук', 'andrii', '2026-10-02T10:00:00.000Z'),
    friendOf('3', 'Ірина Лисенко', 'iryna_l', '2026-10-01T10:00:00.000Z'),
  ]
  const names = (list: Friend[]) => list.map((friend) => friend.user.displayName)

  it('keeps the API order for «Нещодавно додані»', () => {
    expect(names(visibleFriends(friends, '', 'recent'))).toEqual([
      'Тарас Литвин',
      'Андрій Шевчук',
      'Ірина Лисенко',
    ])
  })

  it('orders by name in Ukrainian collation', () => {
    expect(names(visibleFriends(friends, '', 'name'))).toEqual([
      'Андрій Шевчук',
      'Ірина Лисенко',
      'Тарас Литвин',
    ])
  })

  it('matches a part of the name in any case, and a nickname with or without «@»', () => {
    expect(names(visibleFriends(friends, '  ЛИТ ', 'recent'))).toEqual(['Тарас Литвин'])
    expect(names(visibleFriends(friends, '@iryna', 'recent'))).toEqual(['Ірина Лисенко'])
    expect(names(visibleFriends(friends, 'andrii', 'recent'))).toEqual(['Андрій Шевчук'])
    expect(visibleFriends(friends, 'марта', 'recent')).toEqual([])
  })

  it('does not reorder the list it was given', () => {
    visibleFriends(friends, '', 'name')

    expect(names(friends)[0]).toBe('Тарас Литвин')
  })
})

describe('hasFriendsSearch', () => {
  it('treats blanks and a bare «@» as no search', () => {
    expect(hasFriendsSearch('')).toBe(false)
    expect(hasFriendsSearch('   ')).toBe(false)
    expect(hasFriendsSearch('@')).toBe(false)
    expect(hasFriendsSearch('о')).toBe(true)
  })
})

describe('friendsCount and friendsResultLabel', () => {
  it.each([
    [0, '0 друзів'],
    [1, '1 друг'],
    [3, '3 друзі'],
    [5, '5 друзів'],
    [11, '11 друзів'],
    [21, '21 друг'],
    [23, '23 друзі'],
  ])('%i → %s', (count, label) => {
    expect(friendsCount(count)).toBe(label)
  })

  it('says how much of the list a search left, and how much is shown otherwise', () => {
    expect(friendsResultLabel(9, 23, '')).toBe('Показано 9 з 23 друзі')
    expect(friendsResultLabel(2, 23, 'ол')).toBe('Знайдено: 2 друзі')
  })
})

describe('incomingRows', () => {
  const newest = requestOf('a', '2026-11-03T10:00:00.000Z')
  const middle = requestOf('b', '2026-11-02T10:00:00.000Z')
  const oldest = requestOf('c', '2026-11-01T10:00:00.000Z')

  it('keeps an answered request in its place after it left the incoming list', () => {
    const answered: Record<string, AnsweredRequest> = {
      b: { request: middle, outcome: 'accepted' },
    }

    expect(incomingRows([newest, oldest], answered)).toEqual([
      { kind: 'pending', request: newest },
      { kind: 'answered', request: middle, outcome: 'accepted' },
      { kind: 'pending', request: oldest },
    ])
  })

  it('shows an answered request once while the list still has it', () => {
    const answered: Record<string, AnsweredRequest> = {
      a: { request: newest, outcome: 'declined' },
    }

    expect(incomingRows([newest, middle], answered)).toEqual([
      { kind: 'answered', request: newest, outcome: 'declined' },
      { kind: 'pending', request: middle },
    ])
  })

  it('counts only the requests still waiting for an answer', () => {
    const answered: Record<string, AnsweredRequest> = {
      a: { request: newest, outcome: 'accepted' },
    }

    expect(pendingIncomingCount([newest, middle, oldest], answered)).toBe(2)
    expect(pendingIncomingCount([], answered)).toBe(0)
  })
})
