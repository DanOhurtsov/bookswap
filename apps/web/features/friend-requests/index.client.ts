'use client'

export { FriendRequestNotification } from './components/FriendRequestNotification'
export { fetchFriendRequests, respondToFriendRequest } from './api/friend-request-requests'
export {
  FRIEND_REQUESTS_QUERY_KEY,
  useFriendRequestActions,
  type FriendRequestActions,
} from './model/use-friend-request-actions'
