'use client'

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ReadingStatsResponse } from '@bookswap/shared'
import { fetchReadingStats } from '../api/reading-status-requests'
import { toReadingStatsView, type ReadingStatsView } from './reading-stats-view'

/**
 * BS-145: the one key of «this user's reading stats» (CONVENTIONS §3.9). The user is part of it, so
 * another account in the same tab never reads this entry, even before `Providers` clears the cache.
 */
export const readingStatsQueryKey = (userId: string) => ['reading-stats', userId] as const

/** Without it a server-rendered home page would at once ask again for what it has just embedded. */
const READING_STATS_STALE_MS = 30_000

/**
 * How the entry is read and kept — shared by the hook and by `refreshReadingStats`, which may create
 * the entry before any home page has mounted. It outlives its observers (`gcTime: Infinity`): were it
 * collected while the viewer is elsewhere, a back navigation could replay an old server snapshot from
 * Next's back/forward cache into an empty cache as if it were fresh, and a mark left by a save would
 * be lost with it. `Providers` clears the cache on any change of account.
 */
const readingStatsQuery = (userId: string) => ({
  queryKey: readingStatsQueryKey(userId),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchReadingStats(signal),
  // A failed read shows its error with a retry button; repeating it on its own only delays that.
  retry: false,
  staleTime: READING_STATS_STALE_MS,
  gcTime: Infinity,
})

export interface ReadingStatsController {
  view: ReadingStatsView
  /** Manual retry after an error. A failed read is never repeated on its own. */
  retry: () => void
}

/**
 * The viewer's reading stats. Mount it below the session guard, keyed by user.
 *
 * `seed` is the server's snapshot for this same user, given as `initialData`. TanStack applies that to
 * an entry with no counts, never over counts already cached — so newer counts are never overwritten
 * by it. An entry marked out of date by a save (`refreshReadingStats`) gets no seed at all: the
 * snapshot may well have been read before the save, and nothing tells which came first. That entry
 * shows loading and reads the counts once. The mark stays through a failed or cancelled read; only
 * a successful one clears it.
 */
export function useReadingStats({
  userId,
  seed,
}: {
  userId: string
  seed: ReadingStatsResponse | undefined
}): ReadingStatsController {
  const queryClient = useQueryClient()
  const key = readingStatsQueryKey(userId)
  // Set by `refreshReadingStats` after a saved status, cleared by the next successful read.
  const isOutdated = queryClient.getQueryState(key)?.isInvalidated === true
  const query = useQuery({
    ...readingStatsQuery(userId),
    ...(seed === undefined || isOutdated ? {} : { initialData: seed }),
  })

  return {
    view: toReadingStatsView({
      data: query.data,
      error: query.error,
      isError: query.isError,
      isRefreshingOutdated: isOutdated && query.isFetching,
    }),
    retry: () => {
      void query.refetch()
    },
  }
}

/**
 * After a confirmed status save: the stats of that user are out of date, and the cache must say so
 * even when no home page has read them yet.
 *
 * A read still in flight started before the save, so it is cancelled first. Invalidation cancels only
 * the reads it restarts — those of a mounted home page — so a read nobody watches (a prefetch, say)
 * would otherwise land after it, clear the mark and pass the old counts off as fresh.
 *
 * Then the entry is created if there is none — empty, with no counts — so the mark has something to
 * stay on. Without it a save would leave no trace, and a server snapshot read before the save (a
 * navigation to the home page already under way, say) would seed the entry as fresh. With it, the
 * home page refuses that snapshot, shows loading and reads the counts once (`useReadingStats`).
 * Nothing is fetched until a home page mounts.
 *
 * The mounted home page then reads again at once; an unmounted one does on its return.
 *
 * Never awaited by the save: neither its duration nor a failed re-read is the save's business.
 */
export async function refreshReadingStats(queryClient: QueryClient, userId: string): Promise<void> {
  const options = readingStatsQuery(userId)

  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })
  queryClient.getQueryCache().build(queryClient, options)
  await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true })
}
