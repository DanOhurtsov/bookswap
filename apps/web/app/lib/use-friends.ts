'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  friendListResponseSchema,
  friendRequestsResponseSchema,
  type Friend,
  type FriendRequest,
} from '@bookswap/shared'
import { apiRequest, describeError } from './api'
import { useReloadOnResourceChange } from './resource-sync'

/**
 * Ті самі три стани, що й у `useSession`: «ще вантажу» і «порожньо» — різні речі,
 * і без цієї різниці сторінка блимає написом «друзів немає» на кожному оновленні.
 */
export type FriendsState =
  | { status: 'loading' }
  | { status: 'ready'; friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] }
  | { status: 'error'; message: string }

export function useFriends(): { state: FriendsState; reload: () => void } {
  const [state, setState] = useState<FriendsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    async function load(): Promise<void> {
      try {
        // Обидва списки одним заходом: сторінка показує їх поруч, і зріз мусить
        // бути узгодженим — інакше щойно прийнятий запит видно і серед вхідних,
        // і серед друзів одночасно.
        const [friends, requests] = await Promise.all([
          apiRequest('/friends', {
            schema: friendListResponseSchema,
            signal: controller.signal,
          }),
          apiRequest('/friends/requests', {
            schema: friendRequestsResponseSchema,
            signal: controller.signal,
          }),
        ])

        setState({
          status: 'ready',
          friends: friends.friends,
          incoming: requests.incoming,
          outgoing: requests.outgoing,
        })
      } catch (error) {
        if (controller.signal.aborted) return

        setState({ status: 'error', message: describeError(error) })
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [nonce])

  const reload = useCallback(() => {
    setNonce((value) => value + 1)
  }, [])

  // A friend request answered elsewhere (the notifications panel) changes both lists here.
  useReloadOnResourceChange('friends', reload)

  return { state, reload }
}
