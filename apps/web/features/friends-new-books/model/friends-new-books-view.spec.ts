import type { FriendsNewBook, FriendsNewBooksResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { timeAgo, toFriendsNewBooksView } from './friends-new-books-view'

/** Local time, as the reader's calendar: `timeAgo` counts days on it. */
const local = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const iso = (time: number) => new Date(time).toISOString()

const NOW = local(30, 12)

const item = (
  friendId: string,
  workId: string,
  overrides: Partial<FriendsNewBook> = {},
): FriendsNewBook => ({
  friend: {
    id: friendId,
    displayName: `Друг ${friendId}`,
    handle: `h-${friendId}`,
    avatarUrl: null,
  },
  work: { id: workId, title: `Твір ${workId}` },
  authors: [
    { id: 'a-1', name: 'Ліна Костенко', nameLatin: null, role: 'AUTHOR', position: 0 },
    { id: 'a-2', name: 'Іван Драч', nameLatin: null, role: 'AUTHOR', position: 1 },
  ],
  coverUrl: null,
  addedAt: iso(local(28)),
  ...overrides,
})

const feed = (hasFriends: boolean, items: FriendsNewBook[] = []): FriendsNewBooksResponse => ({
  hasFriends,
  items,
})

const settled = { error: null, isError: false, isFetching: false, readAt: NOW }

describe('toFriendsNewBooksView (BS-147)', () => {
  it('is loading until the first answer', () => {
    expect(toFriendsNewBooksView({ ...settled, data: undefined, isFetching: true })).toEqual({
      kind: 'loading',
    })
  })

  it('shows a settled error with its reason, and loading again while a retry runs', () => {
    const error = new ApiRequestError(500, {
      code: 'INTERNAL_ERROR',
      message: 'Сервер недоступний',
    })

    expect(toFriendsNewBooksView({ ...settled, data: undefined, error, isError: true })).toEqual({
      kind: 'error',
      message: 'Не вдалося завантажити нові книжки друзів. Сервер недоступний',
    })
    expect(
      toFriendsNewBooksView({
        ...settled,
        data: undefined,
        error,
        isError: true,
        isFetching: true,
      }),
    ).toEqual({ kind: 'loading' })
  })

  it('a failed refresh shows the error, not the cards it had', () => {
    const error = new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій' })

    expect(
      toFriendsNewBooksView({
        ...settled,
        data: feed(true, [item('f', 'w')]),
        error,
        isError: true,
      }).kind,
    ).toBe('error')
  })

  it('no friends and friends with nothing new are both empty: the canvas has one empty row', () => {
    expect(toFriendsNewBooksView({ ...settled, data: feed(false) })).toEqual({ kind: 'empty' })
    expect(toFriendsNewBooksView({ ...settled, data: feed(true) })).toEqual({ kind: 'empty' })
  })

  it('makes a card per item, in the order of the answer: the work link, cover, authors, friend and when', () => {
    const view = toFriendsNewBooksView({
      ...settled,
      data: feed(true, [
        item('f-2', 'w-1', {
          coverUrl: 'https://covers.example/1.jpg',
          addedAt: iso(local(30, 9)),
        }),
        item('f-1', 'w-1', { authors: [] }),
      ]),
    })

    expect(view).toEqual({
      kind: 'ready',
      cards: [
        {
          key: 'f-2:w-1',
          href: '/works/w-1',
          bookId: 'w-1',
          title: 'Твір w-1',
          authors: 'Ліна Костенко, Іван Драч',
          coverUrl: 'https://covers.example/1.jpg',
          friend: { id: 'f-2', displayName: 'Друг f-2', handle: 'h-f-2', avatarUrl: null },
          addedAt: iso(local(30, 9)),
          addedAgo: '3 год тому',
          ariaLabel: 'Твір w-1, Ліна Костенко, Іван Драч. Додано: Друг f-2, 3 год тому',
        },
        expect.objectContaining({
          key: 'f-1:w-1',
          authors: '',
          addedAgo: '2 дні тому',
          // No authors — no empty «, » in the name.
          ariaLabel: 'Твір w-1. Додано: Друг f-1, 2 дні тому',
        }),
      ],
    })
  })

  it('counts «тому» from when the feed was read, not from the clock', () => {
    const view = toFriendsNewBooksView({
      ...settled,
      data: feed(true, [item('f', 'w', { addedAt: iso(local(30, 11)) })]),
      readAt: local(30, 11, 5),
    })

    expect(view.kind === 'ready' && view.cards[0]?.addedAgo).toBe('5 хв тому')
  })
})

describe('timeAgo', () => {
  it.each([
    ['30 seconds ago', NOW - 30_000, 'щойно'],
    ['a time ahead of now (another clock)', NOW + 60_000, 'щойно'],
    ['one minute ago', NOW - 60_000, '1 хв тому'],
    ['59 minutes ago', NOW - 59 * 60_000, '59 хв тому'],
    ['an hour ago', local(30, 11), '1 год тому'],
    ['at midnight today', local(30, 0), '12 год тому'],
  ])('within today: %s → %s', (_name, time, expected) => {
    expect(timeAgo(iso(time), NOW)).toBe(expected)
  })

  it('the day before is «вчора», even ten minutes ago across midnight', () => {
    expect(timeAgo(iso(local(29, 23, 50)), local(30, 0, 0))).toBe('вчора')
    expect(timeAgo(iso(local(29, 0, 5)), NOW)).toBe('вчора')
  })

  it.each([
    [2, '2 дні тому'],
    [4, '4 дні тому'],
    [5, '5 днів тому'],
    [6, '6 днів тому'],
    [7, 'тиждень тому'],
    [13, 'тиждень тому'],
    [14, '2 тижні тому'],
    [21, '3 тижні тому'],
    [29, '4 тижні тому'],
    [30, 'місяць тому'],
    [59, 'місяць тому'],
    [60, '2 місяці тому'],
    [150, '5 місяців тому'],
    [364, '12 місяців тому'],
    [365, 'рік тому'],
    [730, '2 роки тому'],
    [365 * 5 + 2, '5 років тому'],
  ])('%i calendar days back → %s', (days, expected) => {
    const added = new Date(2026, 9, 30 - days, 18).getTime()

    expect(timeAgo(iso(added), NOW)).toBe(expected)
  })
})
