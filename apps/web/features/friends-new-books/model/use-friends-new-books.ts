'use client'

import { useQuery } from '@tanstack/react-query'
import { friendsNewBooksResponseSchema } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { toFriendsNewBooksView, type FriendsNewBooksView } from './friends-new-books-view'

/**
 * BS-147: the one key of «what this user's friends have added» (CONVENTIONS §3.9). The user is part of
 * it, so another account in the same tab never reads this entry, even before `Providers` clears the
 * cache.
 */
export const friendsNewBooksQueryKey = (userId: string) => ['friends-new-books', userId] as const

/** Coming back to the home page within this time shows the cached feed without asking again. */
const FRIENDS_NEW_BOOKS_STALE_MS = 30_000

const fetchFriendsNewBooks = (signal: AbortSignal) =>
  apiRequest('/me/friends/new-books', { schema: friendsNewBooksResponseSchema, signal })

export interface FriendsNewBooksController {
  view: FriendsNewBooksView
  /** Manual retry after an error. A failed read is never repeated on its own. */
  retry: () => void
}

/** Mount it below the session guard, keyed by user. */
export function useFriendsNewBooks(userId: string): FriendsNewBooksController {
  const query = useQuery({
    queryKey: friendsNewBooksQueryKey(userId),
    queryFn: ({ signal }) => fetchFriendsNewBooks(signal),
    // As for the sections beside it: a failed read shows its error with a retry button at once.
    retry: false,
    staleTime: FRIENDS_NEW_BOOKS_STALE_MS,
  })

  return {
    view: toFriendsNewBooksView({
      data: query.data,
      error: query.error,
      isError: query.isError,
      isFetching: query.isFetching,
      readAt: query.dataUpdatedAt,
    }),
    retry: () => {
      void query.refetch()
    },
  }
}
