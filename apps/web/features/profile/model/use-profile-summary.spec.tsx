/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ProfileSummary } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { useProfileSummary } from './use-profile-summary'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function summary(copies: number): ProfileSummary {
  return {
    stats: { copies, friends: 0, lentLoans: 0, wishlist: 0 },
    reliability: { returnedOnTime: 0, returnedWithDue: 0, averageLoanDays: null, outNow: 0 },
    books: { items: [], total: copies },
    friends: { items: [], total: 0 },
    activity: [],
  }
}

function copiesShown(view: ReturnType<typeof useProfileSummary>['view']): string | undefined {
  return view.kind === 'ready' ? view.stats[0]?.value : undefined
}

beforeEach(() => {
  apiRequest.mockReset()
})

describe('useProfileSummary', () => {
  it('ключ — свій для кожного користувача: інший акаунт читає своє зведення, а не чуже', async () => {
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      withQueryClient(<>{children}</>, client)

    apiRequest.mockResolvedValueOnce(summary(3)).mockResolvedValueOnce(summary(7))

    const { result, rerender } = renderHook(({ userId }) => useProfileSummary(userId), {
      initialProps: { userId: 'user-1' },
      wrapper,
    })

    await waitFor(() => {
      expect(copiesShown(result.current.view)).toBe('3')
    })

    rerender({ userId: 'user-2' })

    expect(copiesShown(result.current.view)).toBeUndefined()
    await waitFor(() => {
      expect(copiesShown(result.current.view)).toBe('7')
    })
    expect(apiRequest).toHaveBeenCalledTimes(2)
    expect(apiRequest).toHaveBeenCalledWith('/me/profile-summary', expect.anything())
  })

  it('помилка не повторюється сама; «Спробувати ще» читає знову', async () => {
    apiRequest
      .mockRejectedValueOnce(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій' }))
      .mockResolvedValueOnce(summary(1))

    const { result } = renderHook(() => useProfileSummary('user-1'), {
      wrapper: ({ children }: { children: ReactNode }) => withQueryClient(<>{children}</>),
    })

    await waitFor(() => {
      expect(result.current.view.kind).toBe('error')
    })
    expect(apiRequest).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.retry()
    })

    await waitFor(() => {
      expect(copiesShown(result.current.view)).toBe('1')
    })
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })
})
