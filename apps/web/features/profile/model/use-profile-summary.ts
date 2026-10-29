'use client'

import { useQuery } from '@tanstack/react-query'
import { profileSummarySchema } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { toProfileSummaryView, type ProfileSummaryView } from './profile-view'

/**
 * BS-148: the one key of «this user's profile summary» (CONVENTIONS §3.9). The user is part of it, so
 * another account in the same tab never reads this entry, even before `Providers` clears the cache.
 */
export const profileSummaryQueryKey = (userId: string) => ['profile-summary', userId] as const

/** Coming back to the profile within this time shows the cached summary without asking again. */
const PROFILE_SUMMARY_STALE_MS = 30_000

const fetchProfileSummary = (signal: AbortSignal) =>
  apiRequest('/me/profile-summary', { schema: profileSummarySchema, signal })

export interface ProfileSummaryController {
  view: ProfileSummaryView
  /** Manual retry after an error. A failed read is never repeated on its own. */
  retry: () => void
}

/** Mount it below the session guard, keyed by user. */
export function useProfileSummary(userId: string): ProfileSummaryController {
  const query = useQuery({
    queryKey: profileSummaryQueryKey(userId),
    queryFn: ({ signal }) => fetchProfileSummary(signal),
    // As the home page's feeds: a failed read shows its error with a retry button at once.
    retry: false,
    staleTime: PROFILE_SUMMARY_STALE_MS,
  })

  return {
    view: toProfileSummaryView(
      {
        data: query.data,
        error: query.error,
        isError: query.isError,
        isFetching: query.isFetching,
      },
      new Date(),
    ),
    retry: () => {
      void query.refetch()
    },
  }
}
