'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { loanListResponseSchema } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { toIncomingRequestsView, type IncomingRequestsView } from './incoming-requests-view'

/**
 * BS-147: the one key of «requests on this owner's books» (CONVENTIONS §3.9). The user is part of it,
 * so another account in the same tab never reads this entry, even before `Providers` clears the cache.
 */
export const incomingRequestsQueryKey = (userId: string) =>
  ['loans', 'incoming-requests', userId] as const

const fetchIncomingRequests = (signal: AbortSignal) =>
  apiRequest('/loans?role=owner&status=REQUESTED', { schema: loanListResponseSchema, signal })

export interface IncomingRequestsController {
  view: IncomingRequestsView
  /** Manual retry after an error. A failed read is never repeated on its own. */
  retry: () => void
  /** Reads the list again after an answer; resolves once the new list is in. */
  refresh: () => Promise<void>
}

/** Mount it below the session guard, keyed by user. */
export function useIncomingRequests(userId: string): IncomingRequestsController {
  const queryClient = useQueryClient()
  const queryKey = incomingRequestsQueryKey(userId)
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchIncomingRequests(signal),
    retry: false,
    // Always stale: `/loans` answers requests through its own hooks, which never touch this key, so
    // every return to the home page reads the list again.
    staleTime: 0,
  })

  return {
    view: toIncomingRequestsView({
      data: query.data,
      error: query.error,
      isError: query.isError,
      isFetching: query.isFetching,
      readAt: query.dataUpdatedAt,
    }),
    retry: () => {
      void query.refetch()
    },
    refresh: () => queryClient.invalidateQueries({ queryKey, exact: true }),
  }
}
