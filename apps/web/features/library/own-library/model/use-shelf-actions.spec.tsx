/** @jest-environment jsdom */

import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { OwnCopy } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { createTestQueryClient } from '@/app/lib/test-query-client'
import { ACTIVATION_QUERY_KEY } from '@/features/library/activation/index.client'
import { useShelfActions } from './use-shelf-actions'

/**
 * Delete, archive and restore share one order: request → the activation checklist hears about it →
 * the shelf reloads. The order, the lock and what a failure leaves behind are what is pinned here.
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const COPY = { id: 'copy-1' } as OwnCopy

function setup() {
  const client = createTestQueryClient()
  const log: string[] = []
  const invalidate = jest.spyOn(client, 'invalidateQueries').mockImplementation(() => {
    log.push('invalidate')

    return Promise.resolve()
  })
  const reload = jest.fn(() => {
    log.push('reload')

    return Promise.resolve()
  })

  mockApiRequest.mockImplementation(() => {
    log.push('request')

    return Promise.resolve({})
  })

  const { result } = renderHook(() => useShelfActions(reload), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })

  return { result, log, invalidate, reload }
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('useShelfActions', () => {
  it.each([
    ['archive', '/me/library/copy-1/archive'],
    ['restore', '/me/library/copy-1/restore'],
  ] as const)(
    '%s: POST, then the checklist, then the shelf — in that order',
    async (name, path) => {
      const { result, log, invalidate } = setup()

      act(() => {
        result.current[name](COPY)
      })

      await waitFor(() => {
        expect(log).toEqual(['request', 'invalidate', 'reload'])
      })
      expect(mockApiRequest).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'POST' }))
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ACTIVATION_QUERY_KEY })
      expect(result.current.isBusy).toBe(false)
    },
  )

  it('delete asks first, and only a confirmed delete is sent', async () => {
    const { result, log } = setup()

    act(() => {
      result.current.askToDelete(COPY)
    })

    expect(result.current.pendingDelete).toBe(COPY)
    expect(mockApiRequest).not.toHaveBeenCalled()

    act(() => {
      result.current.confirmDelete()
    })

    await waitFor(() => {
      expect(log).toEqual(['request', 'invalidate', 'reload'])
    })
    expect(mockApiRequest).toHaveBeenCalledWith('/me/library/copy-1', { method: 'DELETE' })
    expect(result.current.pendingDelete).toBeUndefined()
  })

  it('confirming with nothing pending sends nothing', () => {
    const { result } = setup()

    act(() => {
      result.current.confirmDelete()
    })

    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('cancelling the dialog forgets the copy and sends nothing', () => {
    const { result } = setup()

    act(() => {
      result.current.askToDelete(COPY)
    })
    act(() => {
      result.current.cancelDelete()
    })

    expect(result.current.pendingDelete).toBeUndefined()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('is busy from the request until the reload is done, and a new action clears the old failure', async () => {
    const { result } = setup()
    let finish: () => void = () => undefined

    mockApiRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({})
          }
        }),
    )

    act(() => {
      result.current.reportFailure(new Error('старе'))
    })
    expect(result.current.failure).toBeInstanceOf(Error)

    act(() => {
      result.current.archive(COPY)
    })

    await waitFor(() => {
      expect(result.current.isBusy).toBe(true)
    })
    expect(result.current.failure).toBeUndefined()

    act(() => {
      finish()
    })

    await waitFor(() => {
      expect(result.current.isBusy).toBe(false)
    })
  })

  it('a failed request keeps the API error, skips the checklist and the reload, and closes the dialog', async () => {
    const { result, log } = setup()
    const error = new ApiRequestError(409, { code: 'CONFLICT', message: 'Конфлікт' })

    mockApiRequest.mockRejectedValue(error)

    act(() => {
      result.current.askToDelete(COPY)
    })
    act(() => {
      result.current.confirmDelete()
    })

    await waitFor(() => {
      expect(result.current.failure).toBe(error)
    })
    expect(result.current.isBusy).toBe(false)
    expect(result.current.pendingDelete).toBeUndefined()
    expect(log).toEqual([])
  })

  it('any other error becomes the generic message', async () => {
    const { result } = setup()
    const error = new Error('мережа')

    mockApiRequest.mockRejectedValue(error)

    act(() => {
      result.current.archive(COPY)
    })

    await waitFor(() => {
      expect(result.current.failure).toEqual(new Error(describeError(error)))
    })
  })

  it('shows a failure reported by a row', () => {
    const { result } = setup()
    const error = new Error('рядок не зберігся')

    act(() => {
      result.current.reportFailure(error)
    })

    expect(result.current.failure).toBe(error)
  })
})
