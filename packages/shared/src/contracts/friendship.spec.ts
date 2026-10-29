import { FRIEND_RELATION, FRIENDSHIP_STATUS } from '../domain/friendship'
import {
  createFriendRequestSchema,
  friendListResponseSchema,
  friendRequestsResponseSchema,
  friendshipStateResponseSchema,
  respondFriendRequestSchema,
} from './friendship'

describe('createFriendRequestSchema', () => {
  it('приймає id користувача', () => {
    expect(createFriendRequestSchema.parse({ userId: 'user-1' })).toEqual({ userId: 'user-1' })
  })

  it('обрізає пробіли — id з копіпасти не має ставати іншим id', () => {
    expect(createFriendRequestSchema.parse({ userId: ' user-1 ' })).toEqual({ userId: 'user-1' })
  })

  it('відхиляє порожній і надто довгий id', () => {
    expect(createFriendRequestSchema.safeParse({ userId: '' }).success).toBe(false)
    expect(createFriendRequestSchema.safeParse({ userId: '   ' }).success).toBe(false)
    expect(createFriendRequestSchema.safeParse({ userId: 'x'.repeat(65) }).success).toBe(false)
  })

  it('відхиляє відсутнє поле', () => {
    expect(createFriendRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('respondFriendRequestSchema', () => {
  it.each(['accept', 'decline'])('приймає action=%s (§8)', (action) => {
    expect(respondFriendRequestSchema.parse({ action })).toEqual({ action })
  })

  it('відхиляє дії поза §8 — block і remove мають власні маршрути', () => {
    expect(respondFriendRequestSchema.safeParse({ action: 'block' }).success).toBe(false)
    expect(respondFriendRequestSchema.safeParse({ action: 'remove' }).success).toBe(false)
  })
})

describe('friendListResponseSchema', () => {
  const friend = {
    user: { id: 'user-1', displayName: 'Марта Крук', handle: 'marta', avatarUrl: null },
    friendsSince: '2026-08-15T10:00:00.000Z',
  }

  it('приймає список друзів', () => {
    expect(friendListResponseSchema.safeParse({ friends: [friend] }).success).toBe(true)
  })

  it('приймає порожній список — це валідна відповідь, а не помилка', () => {
    expect(friendListResponseSchema.safeParse({ friends: [] }).success).toBe(true)
  })

  it('віддає лише §9-проєкцію: email друга відкидається', () => {
    const parsed = friendListResponseSchema.parse({
      friends: [{ ...friend, user: { ...friend.user, email: 'marta@example.com' } }],
    })

    expect(parsed.friends[0]?.user).not.toHaveProperty('email')
  })

  it('вимагає ISO-дату', () => {
    expect(
      friendListResponseSchema.safeParse({ friends: [{ ...friend, friendsSince: '15.08.2026' }] })
        .success,
    ).toBe(false)
  })
})

describe('friendRequestsResponseSchema', () => {
  it('вимагає обидва списки — сторінка показує їх разом', () => {
    expect(friendRequestsResponseSchema.safeParse({ incoming: [] }).success).toBe(false)
    expect(friendRequestsResponseSchema.safeParse({ incoming: [], outgoing: [] }).success).toBe(
      true,
    )
  })

  it('запит адресується id рядка, а не id людини (§8)', () => {
    const request = {
      id: 'friendship-1',
      user: { id: 'user-2', displayName: 'Олесь', handle: 'oles', avatarUrl: null },
      createdAt: '2026-08-15T10:00:00.000Z',
    }

    expect(
      friendRequestsResponseSchema.parse({ incoming: [request], outgoing: [] }).incoming[0]?.id,
    ).toBe('friendship-1')
  })
})

describe('friendshipStateResponseSchema', () => {
  it.each([...FRIEND_RELATION])('приймає relation=%s', (relation) => {
    expect(friendshipStateResponseSchema.parse({ relation })).toEqual({ relation })
  })

  it('не приймає сирий FriendshipStatus — назовні йде стан пари, не стан рядка', () => {
    for (const status of FRIENDSHIP_STATUS) {
      expect(friendshipStateResponseSchema.safeParse({ relation: status }).success).toBe(false)
    }
  })
})
