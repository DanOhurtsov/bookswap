'use client'

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { FriendRequest, FriendRequestAction, Notification } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { announceResourceChanged } from '@/app/lib/resource-sync'
import {
  fetchFriendRequests,
  markNotificationRead,
  respondToFriendRequest,
} from '../api/friend-request-requests'
import {
  friendRequestNotificationView,
  isRefusal,
  type FriendRequestNotificationView,
  type IncomingRequests,
  type ReadProgress,
  type ResponseProgress,
} from './friend-request-notification'

/** One resource, one key (CONVENTIONS §3.9). */
const FRIEND_REQUESTS_QUERY_KEY = ['friends', 'requests'] as const

export interface FriendRequestActions {
  viewOf: (notification: Notification) => FriendRequestNotificationView
  respond: (notification: Notification, action: FriendRequestAction) => void
  /** Repeats only the mark-as-read; the answer itself is already on the server. */
  retryMarkRead: (notification: Notification) => void
  recheck: () => void
}

type ProgressMap = ReadonlyMap<string, ResponseProgress>

/**
 * Answering `FRIEND_REQUESTED` notifications — the navbar panel and `/notifications` share it, so
 * the two cannot drift apart. Mount it below the session guard, once per notification list.
 *
 * Progress is kept per notification here, not in the rows: a list reload unmounts the rows, and
 * the result must outlive that.
 */
export function useFriendRequestActions(
  notifications: readonly Notification[] | undefined,
): FriendRequestActions {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<ProgressMap>(() => new Map())
  // Synchronous double-click guard: a second click can land before the disabled buttons render.
  const inFlight = useRef(new Set<string>())

  const requests = useQuery({
    queryKey: FRIEND_REQUESTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchFriendRequests(signal),
    select: (data) => data.incoming,
    // One request for the whole list, and none at all when nothing in it is a friend request.
    enabled:
      notifications?.some((notification) => notification.type === 'FRIEND_REQUESTED') ?? false,
    // A failed check is shown with its own retry button; repeating it silently only delays that.
    retry: false,
  })

  const respondMutation = useMutation({
    mutationKey: ['friends', 'respond-request'],
    mutationFn: ({ request, action }: { request: FriendRequest; action: FriendRequestAction }) =>
      respondToFriendRequest(request.id, action),
    retry: false,
    onSuccess: () => refreshFriends(queryClient),
    // After a refusal the list here is out of date; after a network error it is not, and a
    // refetch that fails as well would replace the buttons the person needs to try again.
    onError: (error) => (isRefusal(error) ? refreshFriends(queryClient) : undefined),
  })

  const markReadMutation = useMutation({
    mutationKey: ['notifications', 'mark-read'],
    mutationFn: markNotificationRead,
    retry: false,
    onSuccess: () => announceResourceChanged('notifications'),
  })

  const incoming = incomingOf(requests)

  function update(notificationId: string, next: ResponseProgress): void {
    setProgress((map) => new Map(map).set(notificationId, next))
  }

  function updateRead(notificationId: string, read: ReadProgress): void {
    setProgress((map) => {
      const current = map.get(notificationId)

      // Mark-as-read only ever follows a confirmed answer; there is nothing else to annotate.
      return current?.phase === 'responded'
        ? new Map(map).set(notificationId, { ...current, read })
        : map
    })
  }

  const viewOf = (notification: Notification): FriendRequestNotificationView =>
    friendRequestNotificationView(notification, incoming, progress.get(notification.id))

  async function markRead(notification: Notification): Promise<void> {
    const guard = `read:${notification.id}`

    if (inFlight.current.has(guard)) return

    inFlight.current.add(guard)
    updateRead(notification.id, 'marking')

    try {
      await markReadMutation.mutateAsync(notification.id)
      updateRead(notification.id, 'done')
    } catch {
      updateRead(notification.id, 'failed')
    } finally {
      inFlight.current.delete(guard)
    }
  }

  async function respond(notification: Notification, action: FriendRequestAction): Promise<void> {
    const view = viewOf(notification)

    if (view.kind !== 'answerable' || inFlight.current.has(view.request.id)) return

    const { request } = view

    inFlight.current.add(request.id)
    update(notification.id, { phase: 'responding', action, request })

    try {
      await respondMutation.mutateAsync({ request, action })
    } catch (error) {
      update(
        notification.id,
        isRefusal(error)
          ? { phase: 'refused' }
          : { phase: 'failed', message: describeError(error) },
      )

      return
    } finally {
      inFlight.current.delete(request.id)
    }

    // The answer is confirmed: show it before, and regardless of, the mark-as-read below.
    const alreadyRead = notification.readAt !== null

    update(notification.id, {
      phase: 'responded',
      action,
      user: request.user,
      read: alreadyRead ? 'done' : 'marking',
    })

    if (!alreadyRead) await markRead(notification)
  }

  return {
    viewOf,
    respond: (notification, action) => void respond(notification, action),
    retryMarkRead: (notification) => void markRead(notification),
    recheck: () => void requests.refetch(),
  }
}

/** The TanStack list here, and every mounted legacy reader (`useFriends`) of the same data. */
function refreshFriends(queryClient: QueryClient): Promise<void> {
  announceResourceChanged('friends')

  return queryClient.invalidateQueries({ queryKey: FRIEND_REQUESTS_QUERY_KEY })
}

function incomingOf(requests: {
  data: FriendRequest[] | undefined
  error: unknown
  isError: boolean
}): IncomingRequests {
  // A list already on screen wins over a failed refresh of it.
  if (requests.data !== undefined) return { status: 'ready', incoming: requests.data }
  if (requests.isError) return { status: 'error', message: describeError(requests.error) }

  return { status: 'loading' }
}
