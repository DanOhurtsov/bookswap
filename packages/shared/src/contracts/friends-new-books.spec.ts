import {
  FRIENDS_NEW_BOOKS_LIMITS,
  friendsNewBooksResponseSchema,
  type FriendsNewBook,
} from './friends-new-books'

const card = (index: number): FriendsNewBook => ({
  friend: { id: `friend-${String(index)}`, displayName: 'Марта', handle: 'marta', avatarUrl: null },
  work: { id: `work-${String(index)}`, title: 'Тигролови' },
  authors: [{ id: 'a-1', name: 'Іван Багряний', nameLatin: null, role: 'AUTHOR', position: 0 }],
  coverUrl: null,
  addedAt: '2026-10-30T10:00:00.000Z',
})

describe('friendsNewBooksResponseSchema', () => {
  it('приймає стрічку з картками друзів', () => {
    const feed = { hasFriends: true, items: [card(1), card(2)] }

    expect(friendsNewBooksResponseSchema.parse(feed)).toEqual(feed)
  })

  it('розрізняє «друзів немає» і «друзі є, але нового немає»', () => {
    expect(friendsNewBooksResponseSchema.parse({ hasFriends: false, items: [] })).toEqual({
      hasFriends: false,
      items: [],
    })
    expect(friendsNewBooksResponseSchema.parse({ hasFriends: true, items: [] })).toEqual({
      hasFriends: true,
      items: [],
    })
  })

  it('без друзів карток бути не може', () => {
    expect(
      friendsNewBooksResponseSchema.safeParse({ hasFriends: false, items: [card(1)] }).success,
    ).toBe(false)
  })

  it('не більше загального ліміту карток', () => {
    const items = Array.from({ length: FRIENDS_NEW_BOOKS_LIMITS.total + 1 }, (_, index) =>
      card(index),
    )

    expect(friendsNewBooksResponseSchema.safeParse({ hasFriends: true, items }).success).toBe(false)
  })

  it('не пропускає зайвих полів друга чи картки', () => {
    const withEmail = { ...card(1), friend: { ...card(1).friend, email: 'marta@example.com' } }
    const withCopy = { ...card(1), copyId: 'copy-1' }

    expect(
      friendsNewBooksResponseSchema.safeParse({ hasFriends: true, items: [withEmail] }).success,
    ).toBe(false)
    expect(
      friendsNewBooksResponseSchema.safeParse({ hasFriends: true, items: [withCopy] }).success,
    ).toBe(false)
  })
})
