import type { FriendsReadingItem, FriendsReadingResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { toFriendsReadingView } from './friends-reading-view'

const item = (
  friendId: string,
  workId: string,
  coverUrl: string | null = null,
): FriendsReadingItem => ({
  friend: {
    id: friendId,
    displayName: `Друг ${friendId}`,
    handle: `${friendId}-handle`,
    avatarUrl: null,
  },
  work: { id: workId, title: `Твір ${workId}` },
  authors: [{ id: 'a-1', name: 'Авторка', nameLatin: null, role: 'AUTHOR', position: 0 }],
  coverUrl,
  updatedAt: '2026-10-20T10:00:00.000Z',
})

const page = (hasFriends: boolean, items: FriendsReadingItem[] = []): FriendsReadingResponse => ({
  hasFriends,
  items,
  nextCursor: null,
})

const settled = { error: null, isError: false, isFetching: false }

describe('toFriendsReadingView (BS-137)', () => {
  it('is loading until the first answer', () => {
    expect(toFriendsReadingView({ ...settled, data: undefined, isFetching: true })).toEqual({
      kind: 'loading',
    })
  })

  it('shows a settled error with its reason, and loading again while a retry runs', () => {
    const error = new ApiRequestError(500, {
      code: 'INTERNAL_ERROR',
      message: 'Сервер недоступний',
    })

    expect(
      toFriendsReadingView({ data: undefined, error, isError: true, isFetching: false }),
    ).toEqual({
      kind: 'error',
      message: 'Не вдалося завантажити, що читають друзі. Сервер недоступний',
    })
    expect(
      toFriendsReadingView({ data: undefined, error, isError: true, isFetching: true }),
    ).toEqual({
      kind: 'loading',
    })
  })

  it('a failed refresh shows the error, not the cards it had', () => {
    const error = new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій' })

    expect(
      toFriendsReadingView({
        data: page(true, [item('f', 'w')]),
        error,
        isError: true,
        isFetching: false,
      }).kind,
    ).toBe('error')
  })

  it('tells «no friends» from «friends who read nothing»', () => {
    expect(toFriendsReadingView({ ...settled, data: page(false) })).toEqual({ kind: 'no-friends' })
    expect(toFriendsReadingView({ ...settled, data: page(true) })).toEqual({
      kind: 'nobody-reading',
    })
  })

  it('makes one card per friend and work, in the order of the answer, with both links', () => {
    const view = toFriendsReadingView({
      ...settled,
      data: page(true, [item('f-2', 'w-1', 'https://covers.example/1.jpg'), item('f-1', 'w-1')]),
    })

    expect(view).toEqual({
      kind: 'ready',
      cards: [
        {
          key: 'f-2:w-1',
          title: 'Твір w-1',
          workHref: '/works/w-1',
          coverUrl: 'https://covers.example/1.jpg',
          coverAlt: 'Обкладинка «Твір w-1»',
          authors: item('f-2', 'w-1').authors,
          friend: { id: 'f-2', displayName: 'Друг f-2', handle: 'f-2-handle', avatarUrl: null },
          friendHref: '/u/f-2-handle',
        },
        expect.objectContaining({
          key: 'f-1:w-1',
          coverUrl: null,
          friendHref: '/u/f-1-handle',
        }),
      ],
    })
  })
})
