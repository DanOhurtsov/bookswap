import {
  friendRequestsResponseSchema,
  friendshipStateResponseSchema,
  notificationResponseSchema,
  type FriendRequestAction,
  type FriendRequestsResponse,
  type FriendshipStateResponse,
  type NotificationResponse,
  type RespondFriendRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * `GET /friends/requests` — one call for the whole notification list, not one per notification.
 * Its `incoming` is exactly "pending, and I am the recipient", and each request carries the
 * requester's public projection (name and avatar only, §9).
 */
export function fetchFriendRequests(signal?: AbortSignal): Promise<FriendRequestsResponse> {
  return apiRequest('/friends/requests', { schema: friendRequestsResponseSchema, signal })
}

/** `PATCH /friends/requests/:id` — `:id` is the `Friendship` row, never the requester's user id. */
export function respondToFriendRequest(
  friendshipId: string,
  action: FriendRequestAction,
): Promise<FriendshipStateResponse> {
  const body: RespondFriendRequest = { action }

  return apiRequest(`/friends/requests/${encodeURIComponent(friendshipId)}`, {
    method: 'PATCH',
    body,
    schema: friendshipStateResponseSchema,
  })
}

/** `PATCH /me/notifications/:id/read` — idempotent on the server: a second call changes nothing. */
export function markNotificationRead(notificationId: string): Promise<NotificationResponse> {
  return apiRequest(`/me/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'PATCH',
    schema: notificationResponseSchema,
  })
}
