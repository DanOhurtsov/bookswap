'use client'

import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { UserSearchResult } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { announceResourceChanged } from '@/app/lib/resource-sync'
import {
  FRIEND_REQUESTS_QUERY_KEY,
  fetchFriendRequests,
  respondToFriendRequest,
} from '@/features/friend-requests/index.client'
import { sendFriendRequest, unblockUser } from '../api/user-search-requests'
import { userSearchKeyOf } from './use-user-search'

export type FoundUserAction =
  | { kind: 'request'; userId: string }
  | { kind: 'accept'; userId: string; requestId: string }
  | { kind: 'unblock'; userId: string }

/** What «Прийняти» needs: the friendship row id of the incoming request, from its own request. */
export type AcceptState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; requestId: string }
  /** The list has no request from this person (withdrawn meanwhile): nothing to accept. */
  | { status: 'unavailable' }

export interface FoundUserActions {
  /** Pending actions of this viewer, from the mutation cache: each one blocks all buttons. */
  pending: readonly FoundUserAction[]
  /** The last action's error, only while the same search is on screen. */
  failure: unknown
  acceptStateOf: (userId: string) => AcceptState
  /** Re-asks `GET /friends/requests` — never repeats a friendship change. */
  retryAccept: () => void
  run: (action: FoundUserAction) => void
  /** The text changed: hide the shown error. A pending action keeps running and blocking. */
  dismissFailure: () => void
}

const actionKeyOf = (viewerId: string) => ['users', 'search', 'action', viewerId] as const

/**
 * «Додати», «Прийняти», «Розблокувати» on found people on the search page.
 *
 * The block lives in the mutation cache, not in this hook: `useMutationState` shows the pending
 * action to every instance, a remounted page included, and `run` checks the cache synchronously,
 * so neither a second click before the re-render nor another instance can send it twice. Nothing
 * here ever resets the mutation — hiding an error is local state.
 *
 * After success the searches are refetched first, then every mounted friends reader is told
 * (`announceResourceChanged` reaches the legacy `useFriends`, the invalidation reaches the
 * TanStack request list the notifications share). The action stays pending until the new
 * relations are on screen, so a click cannot act on the old ones.
 */
export function useFoundUserActions(
  viewerId: string,
  results: readonly UserSearchResult[],
  activeQuery: string | undefined,
): FoundUserActions {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<{ error: unknown; query: string | undefined }>()

  const incoming = useQuery({
    queryKey: FRIEND_REQUESTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchFriendRequests(signal),
    select: (data) => data.incoming,
    // Only an incoming request needs its row id; without one, nothing to load.
    enabled: results.some((result) => result.relation === 'REQUEST_RECEIVED'),
    // A failure is shown with its own retry; repeating it silently only delays that.
    retry: false,
  })

  const mutation = useMutation({
    mutationKey: actionKeyOf(viewerId),
    mutationFn: perform,
    retry: false,
    onSuccess: async () => {
      // Started before the announcement, so the searches' own listeners find it in flight.
      const refreshed = queryClient.invalidateQueries({ queryKey: userSearchKeyOf(viewerId) })

      announceResourceChanged('friends')
      void queryClient.invalidateQueries({ queryKey: FRIEND_REQUESTS_QUERY_KEY })
      await refreshed
    },
  })

  const pending = useMutationState({
    filters: { mutationKey: actionKeyOf(viewerId), status: 'pending' },
    select: (entry) => entry.state.variables,
  }).filter(isFoundUserAction)

  function run(action: FoundUserAction): void {
    const inFlight = queryClient
      .getMutationCache()
      .findAll({ mutationKey: actionKeyOf(viewerId), status: 'pending' })

    if (inFlight.length > 0) return

    setFailure(undefined)
    mutation.mutate(action, { onError: (error) => setFailure({ error, query: activeQuery }) })
  }

  function acceptStateOf(userId: string): AcceptState {
    // A list already on screen wins over a failed refresh of it.
    if (incoming.data !== undefined) {
      const request = incoming.data.find((item) => item.user.id === userId)

      return request === undefined
        ? { status: 'unavailable' }
        : { status: 'ready', requestId: request.id }
    }

    // A retry is loading again, not still failed.
    return incoming.isError && !incoming.isFetching
      ? { status: 'failed', message: describeError(incoming.error) }
      : { status: 'loading' }
  }

  return {
    pending,
    failure: failure !== undefined && failure.query === activeQuery ? failure.error : undefined,
    acceptStateOf,
    retryAccept: () => void incoming.refetch(),
    run,
    dismissFailure: () => setFailure(undefined),
  }
}

async function perform(action: FoundUserAction): Promise<void> {
  switch (action.kind) {
    case 'request':
      await sendFriendRequest(action.userId)
      return
    case 'accept':
      await respondToFriendRequest(action.requestId, 'accept')
      return
    case 'unblock':
      await unblockUser(action.userId)
      return
  }
}

/** The mutation cache stores variables as `unknown`; only this hook's actions carry its key. */
function isFoundUserAction(value: unknown): value is FoundUserAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'userId' in value &&
    typeof value.userId === 'string'
  )
}
