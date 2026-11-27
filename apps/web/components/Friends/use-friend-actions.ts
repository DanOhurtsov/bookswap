'use client'

import { useEffect, useRef, useState } from 'react'
import {
  friendshipStateResponseSchema,
  type FriendRequest,
  type PublicUser,
} from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { announceResourceChanged } from '@/app/lib/resource-sync'
import type { FriendsResource } from '@/app/lib/use-friends'
import {
  currentAnswers,
  type AnsweredRequests,
  type IncomingSnapshot,
  type RequestOutcome,
} from './friends-view'

export interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

export interface FriendActions {
  /** The action in flight (`accept:<requestId>`, `remove:<userId>`, …); one at a time. */
  busyKey: string | undefined
  failure: unknown
  /** Incoming requests answered on this page, by request id (`incomingRows`). */
  answered: AnsweredRequests
  confirmation: Confirmation | undefined
  respond: (request: FriendRequest, action: 'accept' | 'decline') => void
  /** `returnFocusTo`: what opened it from a menu — the menu item itself is gone by then. */
  confirmRemoveFriend: (friend: PublicUser, returnFocusTo?: HTMLElement | null) => void
  confirmBlock: (user: PublicUser, returnFocusTo?: HTMLElement | null) => void
  confirmCancelRequest: (request: FriendRequest) => void
  dismissConfirmation: () => void
}

const OUTCOMES: Readonly<Record<'accept' | 'decline', RequestOutcome>> = {
  accept: 'accepted',
  decline: 'declined',
}

/**
 * The incoming requests answered on this page, by request id. A request sent again after its
 * answer comes back in a fresh read under the same id: `incomingRows` already shows it as waiting,
 * and its old outcome is dropped here as well, so a later read without the request does not bring
 * that outcome back. Dropped during render (React's "derive state from props" pattern), not in an
 * effect: `currentAnswers` returns the same answers once nothing is over, so this settles at once.
 */
function useAnsweredRequests(snapshot: IncomingSnapshot | undefined) {
  const [answered, setAnswered] = useState<AnsweredRequests>({})
  const current = snapshot === undefined ? answered : currentAnswers(answered, snapshot)

  if (current !== answered) setAnswered(current)

  function record(request: FriendRequest, outcome: RequestOutcome, staleThrough: number): void {
    setAnswered((previous) => ({ ...previous, [request.id]: { request, outcome, staleThrough } }))
  }

  return { answered: current, record }
}

/**
 * Every friend action of `/friends`: the request, the busy key, the failure and the follow-up.
 * One place owns «after a change, announce it»: the lists here reload, and so do the relations in
 * the header people search.
 */
export function useFriendActions({
  state,
  latestRevision,
}: Pick<FriendsResource, 'state' | 'latestRevision'>): FriendActions {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const { answered, record } = useAnsweredRequests(state.status === 'ready' ? state : undefined)
  const returnFocus = useRef<HTMLElement | null>(null)

  // The modal dialog gives the focus back to what had it when it opened. Opened from a «⋯» menu,
  // that is a menu item that no longer exists, so the trigger is focused here once the dialog has
  // closed (this effect runs after the dialog's own). A trigger removed with its friend is skipped.
  useEffect(() => {
    if (confirmation !== undefined) return

    const target = returnFocus.current
    returnFocus.current = null
    if (target?.isConnected === true) target.focus()
  }, [confirmation])

  function confirm(next: Confirmation, returnFocusTo: HTMLElement | null | undefined): void {
    returnFocus.current = returnFocusTo ?? null
    setConfirmation(next)
  }

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      announceResourceChanged('friends')
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
      setConfirmation(undefined)
    }
  }

  const removeLink = (userId: string): Promise<void> =>
    run(`remove:${userId}`, async () => {
      await apiRequest(`/friends/${userId}`, { method: 'DELETE' })
    })

  const block = (userId: string): Promise<void> =>
    run(`block:${userId}`, async () => {
      await apiRequest(`/friends/${userId}/block`, { method: 'POST' })
    })

  return {
    busyKey,
    failure,
    answered,
    confirmation,
    respond: (request, action) => {
      void run(`${action}:${request.id}`, async () => {
        await apiRequest(`/friends/requests/${request.id}`, {
          method: 'PATCH',
          body: { action },
          schema: friendshipStateResponseSchema,
        })
        // Recorded before the reload is announced: the row keeps its place with the outcome, and
        // every load requested until now — the one the announce requests comes later — is stale.
        record(request, OUTCOMES[action], latestRevision())
      })
    },
    confirmRemoveFriend: (friend, returnFocusTo) => {
      confirm(
        {
          title: `Видалити ${friend.displayName} з друзів?`,
          description:
            'Активні позичання це не скасує. Ви більше не бачитимете бібліотеку одне одного.',
          confirmLabel: 'Видалити',
          run: () => removeLink(friend.id),
        },
        returnFocusTo,
      )
    },
    confirmBlock: (user, returnFocusTo) => {
      confirm(
        {
          title: `Заблокувати ${user.displayName}?`,
          description:
            'Ця людина не зможе надсилати вам запити й бачити вашу бібліотеку. Дружбу буде розірвано.',
          confirmLabel: 'Заблокувати',
          run: () => block(user.id),
        },
        returnFocusTo,
      )
    },
    confirmCancelRequest: (request) => {
      confirm(
        {
          title: `Скасувати запит до ${request.user.displayName}?`,
          description: 'Людина більше не побачить його серед вхідних запитів.',
          confirmLabel: 'Скасувати запит',
          run: () => removeLink(request.user.id),
        },
        undefined,
      )
    },
    dismissConfirmation: () => {
      setConfirmation(undefined)
    },
  }
}
