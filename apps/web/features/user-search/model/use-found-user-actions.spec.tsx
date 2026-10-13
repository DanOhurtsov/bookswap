/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { advance, createServer, requestsOf } from '../user-search.test-helpers'
import { useFoundUserActions } from './use-found-user-actions'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeEach(() => {
  jest.useFakeTimers()
  apiRequest.mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('useFoundUserActions', () => {
  it('runs an action once even when asked twice before any re-render, from two instances', async () => {
    const server = createServer()

    server.flags.holdActions = true
    apiRequest.mockImplementation(server.handle)

    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      withQueryClient(<>{children}</>, client)
    const first = renderHook(() => useFoundUserActions('me', [], 'Олена'), { wrapper })
    const second = renderHook(() => useFoundUserActions('me', [], 'Олена'), { wrapper })

    act(() => {
      first.result.current.run({ kind: 'request', userId: 'olena' })
      first.result.current.run({ kind: 'request', userId: 'olena' })
      second.result.current.run({ kind: 'request', userId: 'olena' })
    })
    await advance(0)

    expect(requestsOf(apiRequest, '/friends/requests', 'POST')).toHaveLength(1)
    expect(second.result.current.pending).toEqual([{ kind: 'request', userId: 'olena' }])

    // Hiding an error never ends a pending action.
    act(() => first.result.current.dismissFailure())
    expect(first.result.current.pending).toHaveLength(1)

    server.heldActions[0]?.answer()
    await advance(0)
    expect(first.result.current.pending).toEqual([])
  })
})
