/** @jest-environment jsdom */

import { SEARCH_MAX_PAGE } from '@bookswap/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { NextPage } from './search-page'
import {
  SEARCH_PAGE_STALE_MS,
  pagesAheadOf,
  searchPageQueryDefaults,
  useCachedQueryState,
  usePagesAhead,
  type PagesAheadInput,
} from './use-pages-ahead'

describe('searchPageQueryDefaults', () => {
  type Page = { complete: boolean }

  const staleTimeOf = (state: { status: 'success' | 'error'; data: Page | undefined }) =>
    searchPageQueryDefaults<Page>((data) => data.complete).staleTime({ state })

  it('reuses a final page for a while', () => {
    expect(staleTimeOf({ status: 'success', data: { complete: true } })).toBe(SEARCH_PAGE_STALE_MS)
  })

  it('a failed page is stale at once: visiting it asks again', () => {
    expect(staleTimeOf({ status: 'error', data: undefined })).toBe(0)
  })

  it('a partial page left by a cancelled continuation is stale at once, never the end of the list', () => {
    expect(staleTimeOf({ status: 'success', data: { complete: false } })).toBe(0)
  })

  it('never retries and never refetches behind the person’s back', () => {
    expect(searchPageQueryDefaults()).toMatchObject({
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })
  })
})

describe('pagesAheadOf', () => {
  it('is the two pages after the current one, nearest first', () => {
    expect(pagesAheadOf(1)).toEqual([2, 3])
    expect(pagesAheadOf(7)).toEqual([8, 9])
  })

  it('never goes past SEARCH_MAX_PAGE', () => {
    expect(pagesAheadOf(SEARCH_MAX_PAGE - 1)).toEqual([SEARCH_MAX_PAGE])
    expect(pagesAheadOf(SEARCH_MAX_PAGE)).toEqual([])
  })
})

interface Deferred {
  resolve: (next: NextPage) => void
  reject: (error: unknown) => void
}

/** A `load` whose every call waits until the test answers it — the order of asks is the subject. */
function controlledLoad() {
  const pending = new Map<number, Deferred>()
  const asked: number[] = []
  const load = jest.fn(
    (page: number) =>
      new Promise<NextPage>((resolve, reject) => {
        asked.push(page)
        pending.set(page, { resolve, reject })
      }),
  )

  return {
    load,
    asked,
    answer: async (page: number, next: NextPage) => {
      await act(async () => {
        pending.get(page)?.resolve(next)
      })
    },
    fail: async (page: number) => {
      await act(async () => {
        pending.get(page)?.reject(new Error('збій'))
      })
    },
  }
}

function setup(initial: Omit<PagesAheadInput, 'load'>, load: PagesAheadInput['load']) {
  const client = new QueryClient()
  const cancel = jest.spyOn(client, 'cancelQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    (props: Omit<PagesAheadInput, 'load'>) => usePagesAhead({ ...props, load }),
    {
      initialProps: initial,
      wrapper,
    },
  )

  return { ...hook, cancel }
}

const SEARCH = ['test', 'kobzar', 10] as const

describe('usePagesAhead', () => {
  it('waits for the current page: nothing is loaded ahead before it is complete', () => {
    const { load, asked } = controlledLoad()

    setup({ search: SEARCH, page: 1, ready: false, next: 'PROVEN' }, load)

    expect(asked).toEqual([])
  })

  it('page 1: loads 2, and 3 only after 2 has answered and promised it', async () => {
    const queue = controlledLoad()

    setup({ search: SEARCH, page: 1, ready: true, next: 'PROVEN' }, queue.load)

    expect(queue.asked).toEqual([2])

    await queue.answer(2, 'PROVEN')

    expect(queue.asked).toEqual([2, 3])
  })

  it('an unproven next page (UNKNOWN) is loaded too — it is not the end', async () => {
    const queue = controlledLoad()

    setup({ search: SEARCH, page: 1, ready: true, next: 'POSSIBLE' }, queue.load)
    await queue.answer(2, 'POSSIBLE')

    expect(queue.asked).toEqual([2, 3])
  })

  it('a proven end stops it: nothing past the last page', async () => {
    const queue = controlledLoad()
    const none = setup({ search: SEARCH, page: 1, ready: true, next: 'NONE' }, queue.load)

    expect(queue.asked).toEqual([])
    none.unmount()

    const second = controlledLoad()

    setup({ search: SEARCH, page: 1, ready: true, next: 'PROVEN' }, second.load)
    await second.answer(2, 'NONE')

    expect(second.asked).toEqual([2])
  })

  it('moving to page 2 asks 3 again (the cache answers it) and then 4 — never 2', async () => {
    const queue = controlledLoad()
    const { rerender } = setup({ search: SEARCH, page: 1, ready: true, next: 'PROVEN' }, queue.load)

    await queue.answer(2, 'PROVEN')
    await queue.answer(3, 'PROVEN')
    rerender({ search: SEARCH, page: 2, ready: true, next: 'PROVEN' })
    await queue.answer(3, 'PROVEN')

    expect(queue.asked).toEqual([2, 3, 3, 4])
  })

  it('a page opened directly: N+1, then N+2', async () => {
    const queue = controlledLoad()

    setup({ search: SEARCH, page: 7, ready: true, next: 'PROVEN' }, queue.load)
    await queue.answer(8, 'PROVEN')

    expect(queue.asked).toEqual([8, 9])
  })

  it('never past SEARCH_MAX_PAGE', async () => {
    const queue = controlledLoad()

    setup({ search: SEARCH, page: SEARCH_MAX_PAGE - 1, ready: true, next: 'PROVEN' }, queue.load)
    await queue.answer(SEARCH_MAX_PAGE, 'PROVEN')

    expect(queue.asked).toEqual([SEARCH_MAX_PAGE])
  })

  it('a failed page quietly ends the queue', async () => {
    const queue = controlledLoad()

    setup({ search: SEARCH, page: 1, ready: true, next: 'PROVEN' }, queue.load)
    await queue.fail(2)

    expect(queue.asked).toEqual([2])
  })

  it('another search stops the old queue and cancels the old search’s requests', async () => {
    const queue = controlledLoad()
    const { rerender, cancel } = setup(
      { search: SEARCH, page: 1, ready: true, next: 'PROVEN' },
      queue.load,
    )
    const other = ['test', 'shevchenko', 10] as const

    rerender({ search: other, page: 1, ready: false, next: 'NONE' })
    await queue.answer(2, 'PROVEN')

    expect(cancel).toHaveBeenCalledWith({ queryKey: SEARCH })
    // The old queue's answer for page 2 does not go on to page 3 of the old search.
    expect(queue.asked).toEqual([2])
  })

  it('a change of what is asked (asks) restarts the queue from the next page', async () => {
    const queue = controlledLoad()
    const { rerender } = setup(
      { search: SEARCH, page: 1, ready: true, next: 'PROVEN', asks: 'local' },
      queue.load,
    )

    rerender({ search: SEARCH, page: 1, ready: true, next: 'PROVEN', asks: 'local+external' })

    expect(queue.asked).toEqual([2, 2])
  })

  it('the same search under a new array identity is not another search', () => {
    const queue = controlledLoad()
    const { rerender, cancel } = setup(
      { search: SEARCH, page: 1, ready: true, next: 'PROVEN' },
      queue.load,
    )

    rerender({ search: [...SEARCH], page: 1, ready: true, next: 'PROVEN' })

    expect(cancel).not.toHaveBeenCalled()
    expect(queue.asked).toEqual([2])
  })
})

describe('useCachedQueryState', () => {
  const KEY = ['test', 'page', 2] as const

  function render(queryKey: readonly unknown[] | undefined, client = new QueryClient()) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    return {
      client,
      ...renderHook(() => useCachedQueryState<string>(queryKey), { wrapper }),
    }
  }

  it('is undefined for no key or nothing cached, and asks nothing', () => {
    const { result, client } = render(KEY)

    expect(result.current).toBeUndefined()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
    expect(render(undefined).result.current).toBeUndefined()
  })

  it('follows the cache as it changes', async () => {
    const { result, client } = render(KEY)

    act(() => {
      client.setQueryData(KEY, 'сторінка 2')
    })

    // Notified after the cache's own batch, never synchronously (no setState in render).
    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'success', data: 'сторінка 2' })
    })
  })

  it('ignores other queries', async () => {
    const { result, client } = render(KEY)

    act(() => {
      client.setQueryData(['test', 'page', 3], 'інша сторінка')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(result.current).toBeUndefined()
  })

  it('does not observe the query: a request in flight is not cancelled when it stops reading', async () => {
    const client = new QueryClient()
    let aborted = false
    const loading = client.prefetchQuery({
      queryKey: KEY,
      queryFn: ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
          })
          setTimeout(() => {
            resolve('готово')
          }, 20)
        }),
    })
    const { unmount } = render(KEY, client)

    unmount()
    await act(async () => {
      await loading
    })

    expect(aborted).toBe(false)
    expect(client.getQueryData(KEY)).toBe('готово')
  })
})
