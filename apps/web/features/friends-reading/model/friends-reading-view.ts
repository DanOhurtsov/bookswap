import type { FriendsReadingResponse, PublicUser, WorkAuthor } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'

/** One friend reading one work — everything the card renders, already decided. */
export interface FriendsReadingCard {
  /** Unique per card: a friend reads a work at most once. */
  key: string
  title: string
  workHref: string
  coverUrl: string | null
  coverAlt: string
  authors: WorkAuthor[]
  friend: PublicUser
  friendHref: string
}

export type FriendsReadingView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** No accepted friend at all — an invitation to find some. */
  | { kind: 'no-friends' }
  /** Friends exist, and none of them is reading anything right now. */
  | { kind: 'nobody-reading' }
  | { kind: 'ready'; cards: FriendsReadingCard[] }

export interface FriendsReadingViewInput {
  data: FriendsReadingResponse | undefined
  error: unknown
  isError: boolean
  /** A read is under way — a manual retry after an error, say. */
  isFetching: boolean
}

const LOAD_FAILED = 'Не вдалося завантажити, що читають друзі.'

/**
 * BS-137. An error is shown once the read has settled: during a retry the section says it is loading
 * again, not that it failed. A failed refresh hides the cards it had (as BS-145 does with the counts
 * beside it), so an old list is never passed off as what friends are reading now.
 */
export function toFriendsReadingView({
  data,
  error,
  isError,
  isFetching,
}: FriendsReadingViewInput): FriendsReadingView {
  if (isError && !isFetching) {
    return { kind: 'error', message: `${LOAD_FAILED} ${describeError(error)}`.trim() }
  }
  if (data === undefined || isError) return { kind: 'loading' }
  if (!data.hasFriends) return { kind: 'no-friends' }
  if (data.items.length === 0) return { kind: 'nobody-reading' }

  return {
    kind: 'ready',
    cards: data.items.map((item) => ({
      key: `${item.friend.id}:${item.work.id}`,
      title: item.work.title,
      workHref: `/works/${item.work.id}`,
      coverUrl: item.coverUrl,
      coverAlt: `Обкладинка «${item.work.title}»`,
      authors: item.authors,
      friend: item.friend,
      friendHref: `/users/${item.friend.id}/library`,
    })),
  }
}
