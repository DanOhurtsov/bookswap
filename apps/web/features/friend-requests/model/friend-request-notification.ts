import type { FriendRequest, FriendRequestAction, Notification, PublicUser } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'

/** Whether the mark-as-read that follows a successful answer has landed. */
export type ReadProgress = 'marking' | 'failed' | 'done'

/** What the screen remembers about one `FRIEND_REQUESTED` notification after the person acted. */
export type ResponseProgress =
  /** The request is kept here: the buttons stay drawn even if the list refetches meanwhile. */
  | { phase: 'responding'; action: FriendRequestAction; request: FriendRequest }
  /** Network or server hiccup: nothing was decided, so the same answer may be sent again. */
  | { phase: 'failed'; message: string }
  /** The server decided: the request is gone, already answered, or the pair is blocked. */
  | { phase: 'refused' }
  /** The answer is on the server. A failed mark-as-read never undoes it. */
  | { phase: 'responded'; action: FriendRequestAction; user: PublicUser; read: ReadProgress }

/** The one `GET /friends/requests` answer the whole list is checked against. */
export type IncomingRequests =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; incoming: FriendRequest[] }

export type FriendRequestNotificationView =
  | { kind: 'checking' }
  | { kind: 'check-failed'; message: string }
  | {
      kind: 'answerable'
      request: FriendRequest
      pendingAction: FriendRequestAction | null
      error: string | null
    }
  | { kind: 'responded'; action: FriendRequestAction; user: PublicUser; read: ReadProgress }
  | { kind: 'refused' }
  /** No longer pending for this person — answered earlier, withdrawn, blocked or deleted. */
  | { kind: 'inactive' }

/**
 * The pending request this notification is about, if the person can still answer it.
 *
 * `readAt` plays no part: read means seen, not answered. `incoming` already means "PENDING and
 * I am the recipient" — the server's state machine decides that, not the client. The requester is
 * matched as well, so the buttons never sit under a notification about somebody else.
 */
export function findAnswerableRequest(
  notification: Pick<Notification, 'payload'>,
  incoming: readonly FriendRequest[],
): FriendRequest | undefined {
  const { friendshipId, actorId } = notification.payload

  return incoming.find((request) => request.id === friendshipId && request.user.id === actorId)
}

export function friendRequestNotificationView(
  notification: Pick<Notification, 'payload'>,
  requests: IncomingRequests,
  progress: ResponseProgress | undefined,
): FriendRequestNotificationView {
  // What this screen has already learned from the server outranks the list it was checked against.
  switch (progress?.phase) {
    case 'responded':
      return {
        kind: 'responded',
        action: progress.action,
        user: progress.user,
        read: progress.read,
      }
    case 'refused':
      return { kind: 'refused' }
    case 'responding':
      return {
        kind: 'answerable',
        request: progress.request,
        pendingAction: progress.action,
        error: null,
      }
    case 'failed':
    case undefined:
      break
  }

  if (requests.status === 'loading') return { kind: 'checking' }
  if (requests.status === 'error') return { kind: 'check-failed', message: requests.message }

  const request = findAnswerableRequest(notification, requests.incoming)

  if (request === undefined) return { kind: 'inactive' }

  return {
    kind: 'answerable',
    request,
    pendingAction: null,
    error: progress?.phase === 'failed' ? progress.message : null,
  }
}

/** 403 blocked or wrong role, 404 gone, 409 already answered: the same answer cannot succeed. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 409])

export function isRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError && REFUSAL_STATUSES.has(error.status)
}
