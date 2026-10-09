/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import { announceResourceChanged } from './resource-sync'
import { useFriends } from './use-friends'
import { useNotifications } from './use-notifications'

jest.mock('./api', () => {
  const actual = jest.requireActual<typeof import('./api')>('./api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('./api')

function callsTo(path: string): number {
  return mockApiRequest.mock.calls.filter(([called]) => called === path).length
}

beforeEach(() => {
  mockApiRequest.mockReset()
  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/friends') return Promise.resolve({ friends: [] })
    if (path === '/friends/requests') return Promise.resolve({ incoming: [], outgoing: [] })

    return Promise.resolve({ notifications: [], unreadCount: 0 })
  })
})

describe('legacy readers follow announced changes', () => {
  it('useFriends reloads both lists when friends change, and only then', async () => {
    const { result } = renderHook(() => useFriends())

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(callsTo('/friends/requests')).toBe(1)

    act(() => announceResourceChanged('notifications'))
    expect(callsTo('/friends/requests')).toBe(1)

    act(() => announceResourceChanged('friends'))

    await waitFor(() => expect(callsTo('/friends/requests')).toBe(2))
    expect(callsTo('/friends')).toBe(2)
  })

  it('every mounted useNotifications instance reloads when notifications change', async () => {
    const badge = renderHook(() => useNotifications(false))
    const unreadPage = renderHook(() => useNotifications(true))

    await waitFor(() => expect(badge.result.current.state.status).toBe('ready'))
    await waitFor(() => expect(unreadPage.result.current.state.status).toBe('ready'))

    act(() => announceResourceChanged('notifications'))

    await waitFor(() => expect(callsTo('/me/notifications')).toBe(2))
    await waitFor(() => expect(callsTo('/me/notifications?unread=true')).toBe(2))
  })

  it('an unmounted reader stops listening', async () => {
    const { result, unmount } = renderHook(() => useFriends())

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    unmount()

    act(() => announceResourceChanged('friends'))

    expect(callsTo('/friends')).toBe(1)
  })
})
