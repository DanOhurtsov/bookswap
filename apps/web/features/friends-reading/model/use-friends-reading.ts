'use client'

import { useQuery } from '@tanstack/react-query'
import { friendsReadingResponseSchema } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { toFriendsReadingView, type FriendsReadingView } from './friends-reading-view'

/**
 * BS-137: the one key of «what this user's friends are reading» (CONVENTIONS §3.9). The user is part
 * of it, so another account in the same tab never reads this entry, even before `Providers` clears the
 * cache.
 */
export const friendsReadingQueryKey = (userId: string) => ['friends-reading', userId] as const

/** Coming back to the home page within this time shows the cached feed without asking again. */
const FRIENDS_READING_STALE_MS = 30_000

/** The first page only, of the server's default size: the home page has no «more». */
const fetchFriendsReading = (signal: AbortSignal) =>
  apiRequest('/me/friends/reading', { schema: friendsReadingResponseSchema, signal })

export interface FriendsReadingController {
  view: FriendsReadingView
  /** Manual retry after an error. A failed read is never repeated on its own. */
  retry: () => void
}

/** Mount it below the session guard, keyed by user. */
export function useFriendsReading(userId: string): FriendsReadingController {
  const query = useQuery({
    queryKey: friendsReadingQueryKey(userId),
    queryFn: ({ signal }) => fetchFriendsReading(signal),
    // Explicit and bounded, as for the reading stats beside it: a failed read shows its error with
    // a retry button at once; repeating it on its own would only delay that.
    retry: false,
    staleTime: FRIENDS_READING_STALE_MS,
  })

  return {
    view: toFriendsReadingView({
      data: query.data,
      error: query.error,
      isError: query.isError,
      isFetching: query.isFetching,
    }),
    retry: () => {
      void query.refetch()
    },
  }
}
