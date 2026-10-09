/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { withQueryClient } from '@/app/lib/test-query-client'
import {
  MARTA,
  createFakeServer,
  friendRequested,
  pendingRequest,
} from '../friend-requests.test-helpers'
import { useFriendRequestActions } from './use-friend-request-actions'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const request = pendingRequest(MARTA, 'friendship-marta')
const notification = friendRequested('n-marta', request)
const loanNotification = {
  id: 'n-loan',
  type: 'LOAN_REQUESTED' as const,
  payload: { loanId: 'loan-1' },
  readAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
}

const wrapper = ({ children }: { children: ReactNode }) => withQueryClient(<>{children}</>)

beforeEach(() => {
  apiRequest.mockReset()
})

describe('useFriendRequestActions', () => {
  it('two answers in the same tick, before any re-render, send one request', async () => {
    const server = createFakeServer({ notifications: [notification], incoming: [request] })

    apiRequest.mockImplementation(server.handle)

    const { result } = renderHook(() => useFriendRequestActions([notification]), { wrapper })

    await waitFor(() => expect(result.current.viewOf(notification).kind).toBe('answerable'))

    const release = server.holdNext('respond')

    act(() => {
      result.current.respond(notification, 'accept')
      result.current.respond(notification, 'decline')
    })
    release()

    await waitFor(() => expect(result.current.viewOf(notification).kind).toBe('responded'))
    expect(server.count(`PATCH /friends/requests/${request.id}`)).toBe(1)
    expect(server.state.friends.map((friend) => friend.user.id)).toEqual([MARTA.id])
  })

  it('does not ask for friend requests when the list has no friend request in it', async () => {
    const server = createFakeServer({ notifications: [loanNotification], incoming: [] })

    apiRequest.mockImplementation(server.handle)

    renderHook(() => useFriendRequestActions([loanNotification]), { wrapper })

    // Give a would-be query the chance to start.
    await act(() => Promise.resolve())
    expect(server.calls).toEqual([])
  })
})
