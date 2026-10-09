import type { FriendRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import {
  findAnswerableRequest,
  friendRequestNotificationView,
  isRefusal,
  type IncomingRequests,
} from './friend-request-notification'

const marta = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }

const request: FriendRequest = {
  id: 'friendship-1',
  user: marta,
  createdAt: '2026-10-01T10:00:00.000Z',
}

const notification = { payload: { actorId: marta.id, friendshipId: request.id } }
const ready: IncomingRequests = { status: 'ready', incoming: [request] }

describe('findAnswerableRequest', () => {
  it('matches the pending row by friendshipId and the requester by actorId', () => {
    expect(findAnswerableRequest(notification, [request])).toBe(request)
  })

  it('does not take the requester’s user id for the request id', () => {
    expect(
      findAnswerableRequest({ payload: { actorId: marta.id, friendshipId: marta.id } }, [request]),
    ).toBeUndefined()
  })

  it('ignores a pending row from somebody else', () => {
    const other = { ...request, user: { ...marta, id: 'user-oles' } }

    expect(findAnswerableRequest(notification, [other])).toBeUndefined()
  })

  it('has nothing to match when the payload lacks the ids', () => {
    expect(findAnswerableRequest({ payload: {} }, [request])).toBeUndefined()
  })
})

describe('friendRequestNotificationView', () => {
  it('offers both answers for a pending incoming request', () => {
    expect(friendRequestNotificationView(notification, ready, undefined)).toEqual({
      kind: 'answerable',
      request,
      pendingAction: null,
      error: null,
    })
  })

  it('is inactive once the request is no longer among the incoming ones', () => {
    expect(
      friendRequestNotificationView(notification, { status: 'ready', incoming: [] }, undefined),
    ).toEqual({ kind: 'inactive' })
  })

  it('waits for the check and reports a failed one', () => {
    expect(friendRequestNotificationView(notification, { status: 'loading' }, undefined)).toEqual({
      kind: 'checking',
    })
    expect(
      friendRequestNotificationView(notification, { status: 'error', message: 'Збій' }, undefined),
    ).toEqual({ kind: 'check-failed', message: 'Збій' })
  })

  it('keeps the buttons of a request being answered even if the list no longer has it', () => {
    const view = friendRequestNotificationView(
      notification,
      { status: 'ready', incoming: [] },
      { phase: 'responding', action: 'accept', request },
    )

    expect(view).toEqual({ kind: 'answerable', request, pendingAction: 'accept', error: null })
  })

  it('leaves the buttons and shows the error after a failure the server did not decide', () => {
    expect(
      friendRequestNotificationView(notification, ready, { phase: 'failed', message: 'Мережа' }),
    ).toEqual({ kind: 'answerable', request, pendingAction: null, error: 'Мережа' })
  })

  it('drops the buttons after a failure if the request has gone meanwhile', () => {
    expect(
      friendRequestNotificationView(
        notification,
        { status: 'ready', incoming: [] },
        { phase: 'failed', message: 'Мережа' },
      ),
    ).toEqual({ kind: 'inactive' })
  })

  it('shows a confirmed answer over the list, whatever the mark-as-read did', () => {
    const view = friendRequestNotificationView(
      notification,
      { status: 'error', message: 'Збій' },
      { phase: 'responded', action: 'decline', user: marta, read: 'failed' },
    )

    expect(view).toEqual({ kind: 'responded', action: 'decline', user: marta, read: 'failed' })
  })

  it('shows a refusal over a list that still lists the request', () => {
    expect(friendRequestNotificationView(notification, ready, { phase: 'refused' })).toEqual({
      kind: 'refused',
    })
  })
})

describe('isRefusal', () => {
  const apiError = (status: number) =>
    new ApiRequestError(status, { code: 'CONFLICT', message: '' })

  it('treats 403, 404 and 409 as the server’s final word', () => {
    expect(isRefusal(apiError(403))).toBe(true)
    expect(isRefusal(apiError(404))).toBe(true)
    expect(isRefusal(apiError(409))).toBe(true)
  })

  it('leaves server errors, rate limits and network failures open to a retry', () => {
    expect(isRefusal(apiError(500))).toBe(false)
    expect(isRefusal(apiError(429))).toBe(false)
    expect(isRefusal(new TypeError('Failed to fetch'))).toBe(false)
  })
})
