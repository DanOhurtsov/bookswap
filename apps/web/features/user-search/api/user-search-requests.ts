import {
  friendshipStateResponseSchema,
  userSearchResponseSchema,
  type CreateFriendRequest,
  type FriendshipStateResponse,
  type UserSearchResult,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * `GET /users?query=` — one request per search: the server unites the partial name match with
 * the exact email match, so the client never merges two searches itself.
 */
export async function searchUsers(query: string, signal: AbortSignal): Promise<UserSearchResult[]> {
  const response = await apiRequest(`/users?query=${encodeURIComponent(query)}`, {
    schema: userSearchResponseSchema,
    signal,
  })

  return response.results
}

/** `POST /friends/requests` — a counter request to someone who asked first means consent. */
export function sendFriendRequest(userId: string): Promise<FriendshipStateResponse> {
  const body: CreateFriendRequest = { userId }

  return apiRequest('/friends/requests', {
    method: 'POST',
    body,
    schema: friendshipStateResponseSchema,
  })
}

/** `DELETE /friends/:userId` — removes the block this user set, along with the link. */
export function unblockUser(userId: string): Promise<void> {
  return apiRequest(`/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}
