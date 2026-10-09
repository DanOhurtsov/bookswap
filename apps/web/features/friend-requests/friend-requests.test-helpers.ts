import type { Friend, FriendRequest, Notification } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'

/**
 * An in-memory API for the notification screens: `apiRequest` is mocked with `server.handle`, and
 * the real hooks above it (`useNotifications`, `useFriends`, TanStack Query) run unchanged. The
 * state changes the way the server's does, so a reload shows what the server would answer.
 */

export const MARTA = { id: 'user-marta', displayName: 'Марта Коваль', avatarUrl: null }
export const OLES = {
  id: 'user-oles',
  displayName: 'Олесь',
  avatarUrl: 'https://cdn.test/oles.png',
}

export function pendingRequest(user: FriendRequest['user'], id: string): FriendRequest {
  return { id, user, createdAt: '2026-10-01T10:00:00.000Z' }
}

export function friendRequested(
  id: string,
  request: Pick<FriendRequest, 'id' | 'user'>,
  readAt: string | null = null,
): Notification {
  return {
    id,
    type: 'FRIEND_REQUESTED',
    payload: { actorId: request.user.id, friendshipId: request.id },
    readAt,
    createdAt: '2026-10-01T10:00:00.000Z',
  }
}

export type HandledCall = 'respond' | 'read'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

interface RequestOptions {
  method?: string
  body?: unknown
}

export function createFakeServer(initial: {
  notifications: Notification[]
  incoming: FriendRequest[]
  friends?: Friend[]
}) {
  const state = {
    notifications: [...initial.notifications],
    incoming: [...initial.incoming],
    friends: [...(initial.friends ?? [])],
  }
  const calls: string[] = []
  const failures = new Map<HandledCall, unknown>()
  const holds = new Map<HandledCall, Deferred>()

  async function intercept(call: HandledCall): Promise<void> {
    const hold = holds.get(call)

    if (hold !== undefined) {
      holds.delete(call)
      await hold.promise
    }

    if (failures.has(call)) {
      const failure = failures.get(call)

      failures.delete(call)
      throw failure
    }
  }

  function respond(friendshipId: string, action: unknown): unknown {
    const request = state.incoming.find((item) => item.id === friendshipId)

    if (request === undefined) {
      throw new ApiRequestError(409, {
        code: 'FRIENDSHIP_INVALID_TRANSITION',
        message: 'Дія неможлива в поточному стані дружби',
      })
    }

    state.incoming = state.incoming.filter((item) => item !== request)

    if (action === 'accept') {
      state.friends.push({ user: request.user, friendsSince: '2026-10-08T10:00:00.000Z' })

      return { relation: 'FRIENDS' }
    }

    return { relation: 'NONE' }
  }

  function read(notificationId: string): unknown {
    state.notifications = state.notifications.map((notification) =>
      notification.id === notificationId && notification.readAt === null
        ? { ...notification, readAt: '2026-10-08T10:00:00.000Z' }
        : notification,
    )

    return { notification: state.notifications.find((item) => item.id === notificationId) }
  }

  function notificationList(unreadOnly: boolean): unknown {
    const unread = state.notifications.filter((notification) => notification.readAt === null)

    return {
      notifications: unreadOnly ? unread : state.notifications,
      unreadCount: unread.length,
    }
  }

  async function handle(path: string, { method = 'GET', body }: RequestOptions = {}) {
    calls.push(`${method} ${path}`)

    const respondMatch = /^\/friends\/requests\/([^/]+)$/.exec(path)
    const readMatch = /^\/me\/notifications\/([^/]+)\/read$/.exec(path)

    if (method === 'PATCH' && respondMatch?.[1] !== undefined) {
      await intercept('respond')

      return respond(respondMatch[1], (body as { action?: unknown } | undefined)?.action)
    }

    if (method === 'PATCH' && readMatch?.[1] !== undefined) {
      await intercept('read')

      return read(readMatch[1])
    }

    if (path === '/friends/requests') return { incoming: state.incoming, outgoing: [] }
    if (path === '/friends') return { friends: state.friends }
    if (path === '/me/notifications') return notificationList(false)
    if (path === '/me/notifications?unread=true') return notificationList(true)

    throw new Error(`Unexpected request: ${method} ${path}`)
  }

  return {
    state,
    handle,
    /** Every request so far, as `METHOD path`. */
    calls,
    count: (call: string) => calls.filter((made) => made === call).length,
    /** The next `call` throws `error` (after any hold). */
    failNext: (call: HandledCall, error: unknown) => failures.set(call, error),
    /** The next `call` waits until the returned function is called. */
    holdNext: (call: HandledCall): (() => void) => {
      const hold = deferred()

      holds.set(call, hold)

      return hold.resolve
    },
  }
}

export type FakeServer = ReturnType<typeof createFakeServer>

export const NETWORK_ERROR = new TypeError('Failed to fetch')
