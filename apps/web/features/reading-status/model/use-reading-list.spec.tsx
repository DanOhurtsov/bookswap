/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { ReadingListItem, ReadingListResponse } from '@bookswap/shared'
import { useReadingList } from './use-reading-list'

/**
 * 10j.2 review: a first page of the previous list must never come back once `setFilter` or
 * `reload` has started a new one.
 *
 * Tested on the hook, not through a click: a click is a discrete React event, and React 19 commits
 * it — and runs the old effect's cleanup — before any promise can settle, so the window never opens
 * in a component test. Here the call and the old answer share one `act` scope: nothing has been
 * committed yet, and only the synchronous abort in the handler stands between the old answer and
 * the screen.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function item(id: string): ReadingListItem {
  return {
    work: {
      id,
      title: `Твір ${id}`,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
    status: 'READ',
    wasBorrowed: false,
    updatedAt: '2026-09-30T10:00:00.000Z',
  }
}

/** Every call gets its own promise; the test decides which one settles and when. */
function deferredResponses(): ((value: ReadingListResponse) => void)[] {
  const settles: ((value: ReadingListResponse) => void)[] = []

  apiRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        settles.push(resolve)
      }),
  )

  return settles
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function titles(state: ReturnType<typeof useReadingList>['state']): string[] {
  return state.status === 'ready' ? state.items.map((entry) => entry.work.title) : []
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
})

describe('useReadingList: a stale first page', () => {
  it('setFilter: the previous filter’s first page settling before commit is dropped', async () => {
    const settles = deferredResponses()
    const { result } = renderHook(() => useReadingList())

    expect(apiRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.setFilter('READING')
      settles[0]?.({ items: [item('w-old')], nextCursor: 'old-cursor' })
      await flushMicrotasks()
    })

    expect(result.current.filter).toBe('READING')
    expect(result.current.state).toEqual({ status: 'loading' })
    expect(apiRequest.mock.calls.map(([path]) => path as string)).toEqual([
      '/me/reading-list',
      '/me/reading-list?status=READING',
    ])

    await act(async () => {
      settles[1]?.({ items: [item('w-new')], nextCursor: null })
      await flushMicrotasks()
    })

    expect(titles(result.current.state)).toEqual(['Твір w-new'])
  })

  it('reload: the first page it replaces is dropped even if it settles first', async () => {
    const settles = deferredResponses()
    const { result } = renderHook(() => useReadingList())

    await act(async () => {
      result.current.reload()
      settles[0]?.({ items: [item('w-old')], nextCursor: null })
      await flushMicrotasks()
    })

    expect(result.current.state).toEqual({ status: 'loading' })

    await act(async () => {
      settles[1]?.({ items: [item('w-fresh')], nextCursor: null })
      await flushMicrotasks()
    })

    expect(titles(result.current.state)).toEqual(['Твір w-fresh'])
  })
})
