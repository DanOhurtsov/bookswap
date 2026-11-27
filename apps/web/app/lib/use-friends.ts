'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  | {
      status: 'ready'
      /** The load that read these lists; see `latestRevision`. */
      revision: number
      friends: Friend[]
      incoming: FriendRequest[]
      outgoing: FriendRequest[]
    }
  | { status: 'error'; message: string }

export interface FriendsResource {
  state: FriendsState
  reload: () => void
  /**
   * The revision of the newest load requested so far, read at call time. Every `reload` requests a
   * new one, so lists whose `revision` is greater were requested after the call: they are not a
   * read that was already under way. A request id and `createdAt` can come back unchanged after
   * the request was answered and sent again, so only this tells an old read from a fresh one.
   */
  latestRevision: () => number
}

export function useFriends(): FriendsResource {
  const [state, setState] = useState<FriendsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  // Bumped synchronously in `reload`, before React renders the new nonce and starts its load.
  const requested = useRef(0)

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
          revision: nonce,
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
    requested.current += 1
    setNonce(requested.current)
  }, [])

  const latestRevision = useCallback(() => requested.current, [])

  // A friend request answered elsewhere (the notifications panel) changes both lists here.
  useReloadOnResourceChange('friends', reload)

  return { state, reload, latestRevision }
}
