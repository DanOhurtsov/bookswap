'use client'

import { SEARCH_MAX_PAGE } from '@bookswap/shared'
import {
  hashKey,
  notifyManager,
  useQueryClient,
  type Query,
  type QueryCacheNotifyEvent,
  type QueryKey,
} from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { NextPage } from './search-page'

/**
 * Search result pages in the shared TanStack Query cache, current and ahead (BS-134,
 * docs/plan/bs-134-search-grid-pagination.md). `/catalog` and the add-book search both page through
 * results; the page on screen (`useQuery`) and the pages loaded ahead (`fetchQuery`) use the SAME query
 * options, so a page loaded ahead is the page shown later, and a request in flight is joined, not repeated.
 */

/** How many pages after the current one are kept loaded. */
export const SEARCH_PAGES_AHEAD = 2

/** A loaded page is reused for this long: going back and forth between pages costs no requests. */
export const SEARCH_PAGE_STALE_MS = 5 * 60_000

/**
 * Query options every search page shares. Searches run when the person acts — not on window focus or
 * reconnect, and a failure is not retried behind their back.
 *
 * A failed page is stale at once, so visiting it asks again. So is a page `isFinal` rejects — e.g. a
 * partial page left in the cache by a cancelled continuation, or one a source failed to answer for:
 * it is shown while it is asked again, never passed off as finished.
 */
export function searchPageQueryDefaults<TData>(isFinal: (data: TData) => boolean = () => true) {
  return {
    staleTime: (query: { state: Pick<Query<TData>['state'], 'status' | 'data'> }) => {
      const { status, data } = query.state

      return status === 'error' || (data !== undefined && !isFinal(data)) ? 0 : SEARCH_PAGE_STALE_MS
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const
}

/**
 * What the shared cache holds under `queryKey` right now, kept current as the cache changes — without
 * observing the query: it starts no request, and nothing in flight is cancelled when it stops reading.
 * `undefined` for no key or nothing cached yet.
 */
export function useCachedQueryState<TData>(
  queryKey: QueryKey | undefined,
): { status: 'pending' | 'error' | 'success'; data: TData | undefined } | undefined {
  const queryClient = useQueryClient()
  const hash = queryKey === undefined ? undefined : hashKey(queryKey)
  // Only this query's events, and never synchronously: the cache also notifies while a `useQuery`
  // builds a query during render, and a store update then would be a setState in render. Batched
  // like TanStack's own observers (`notifyManager.batchCalls`).
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe(
        notifyManager.batchCalls((event: QueryCacheNotifyEvent) => {
          if (event.query.queryHash === hash) notify()
        }),
      ),
    [queryClient, hash],
  )
  const read = () =>
    queryKey === undefined ? undefined : queryClient.getQueryState<TData>(queryKey)

  return useSyncExternalStore(subscribe, read, read)
}

/** The pages to keep ready after `page`, nearest first, never past `SEARCH_MAX_PAGE`. */
export function pagesAheadOf(page: number): number[] {
  const last = Math.min(page + SEARCH_PAGES_AHEAD, SEARCH_MAX_PAGE)

  return Array.from({ length: Math.max(last - page, 0) }, (_, index) => page + 1 + index)
}

export interface PagesAheadInput {
  /** The query-key prefix every page of this search shares; `undefined` — nothing is searched. */
  search: QueryKey | undefined
  page: number
  /** The current page is complete: the pages ahead never compete with it. */
  ready: boolean
  /** What the current page promises about the next one. */
  next: NextPage
  /**
   * Loads one page through the shared cache (reusing a ready answer or joining a request in flight)
   * and says what it promises about the page after it. Rejects when the page failed. The latest one
   * is used for every ask; a new identity alone does not restart the queue.
   */
  load: (page: number) => Promise<NextPage>
  /**
   * What else decides what `load` asks for, beyond `search` — e.g. whether the external half is
   * asked yet. A change restarts the queue (the cache is shared, so nothing is asked twice).
   */
  asks?: string
}

/**
 * Keeps the two pages after the current one loaded, one after another.
 *
 * Page N+2 is asked only once N+1 has answered and promised it; nothing past a proven end or
 * `SEARCH_MAX_PAGE`. Moving to N+1 restarts the queue from there: N+2 is already ready (or in flight,
 * and joined), so only N+3 is new. A failed page quietly ends the queue — the page on screen stays — and
 * stays failed in the cache only until it is visited.
 *
 * Another search (`search` prefix) stops the queue and cancels the old search's requests in flight;
 * their answers stay under the old keys and are never shown for the new one. Nothing here touches the
 * address, focus or scrolling.
 */
export function usePagesAhead(input: PagesAheadInput): void {
  const { search, page, ready, next, asks = '' } = input
  const queryClient = useQueryClient()
  const hash = search === undefined ? undefined : hashKey(search)
  const searchRef = useRef(search)
  const loadRef = useRef(input.load)

  useEffect(() => {
    searchRef.current = search
    loadRef.current = input.load
  })

  useEffect(() => {
    const previous = searchRef.current

    if (hash === undefined || previous === undefined) return

    return () => {
      void queryClient.cancelQueries({ queryKey: previous })
    }
  }, [hash, queryClient])

  useEffect(() => {
    if (hash === undefined || !ready || next === 'NONE') return

    let stopped = false

    async function run(): Promise<void> {
      for (const target of pagesAheadOf(page)) {
        const after = await loadRef.current(target)

        if (stopped || after === 'NONE') return
      }
    }

    // A failed or cancelled page ends the queue; the page on screen does not depend on it.
    run().catch(() => undefined)

    return () => {
      stopped = true
    }
  }, [hash, page, ready, next, asks])
}
