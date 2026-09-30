'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadingListItem, ReadingListStatus } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { fetchReadingList } from '../api/reading-status-requests'

export type ReadingListState =
  | { status: 'loading' }
  | { status: 'ready'; items: ReadingListItem[]; nextCursor: string | null }
  | { status: 'error'; message: string }

export type ReadingListMoreState =
  { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string }

/** `undefined` — both `READING` and `READ`; `NOT_READ` is never listed (T13). */
export type ReadingListFilter = ReadingListStatus | undefined

export interface ReadingListController {
  filter: ReadingListFilter
  setFilter: (filter: ReadingListFilter) => void
  state: ReadingListState
  more: ReadingListMoreState
  reload: () => void
  loadMore: () => Promise<void>
}

/**
 * Stage 10 (10j.2): the viewer's private reading list, one cursor page at a time.
 *
 * A filter change or reload starts a new list and aborts BOTH requests of the old one — its first
 * page and any "load more" — synchronously, inside the handler. Waiting for the effect cleanup is
 * not enough: a first page that settles between the click and React's commit would otherwise pass
 * its `aborted` check and put the previous filter's items back under the new one.
 */
export function useReadingList(): ReadingListController {
  const [filter, setFilterState] = useState<ReadingListFilter>()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ReadingListState>({ status: 'loading' })
  const [more, setMore] = useState<ReadingListMoreState>({ status: 'idle' })

  // Stable boxes, so the unmount cleanup may read them (a bare `ref.current` there is a lint error).
  const firstRequest = useRef<{ controller: AbortController | null }>({ controller: null })
  const moreRequest = useRef<{ controller: AbortController | null }>({ controller: null })

  useEffect(() => {
    const controller = new AbortController()

    firstRequest.current.controller = controller

    fetchReadingList({ status: filter, cursor: undefined }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setState({ status: 'ready', items: page.items, nextCursor: page.nextCursor })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: describeError(error) })
      })

    return () => {
      controller.abort()
    }
  }, [filter, nonce])

  useEffect(() => {
    const box = moreRequest.current

    return () => {
      box.controller?.abort()
    }
  }, [])

  const restart = useCallback(() => {
    firstRequest.current.controller?.abort()
    moreRequest.current.controller?.abort()
    moreRequest.current.controller = null
    setState({ status: 'loading' })
    setMore({ status: 'idle' })
  }, [])

  const setFilter = useCallback(
    (next: ReadingListFilter) => {
      restart()
      setFilterState(next)
    },
    [restart],
  )

  const reload = useCallback(() => {
    restart()
    setNonce((value) => value + 1)
  }, [restart])

  async function loadMore(): Promise<void> {
    if (state.status !== 'ready' || state.nextCursor === null) return
    if (moreRequest.current.controller !== null) return

    const controller = new AbortController()

    moreRequest.current.controller = controller
    setMore({ status: 'loading' })

    try {
      const page = await fetchReadingList(
        { status: filter, cursor: state.nextCursor },
        controller.signal,
      )

      if (controller.signal.aborted) return

      setState((previous) =>
        previous.status === 'ready'
          ? {
              status: 'ready',
              items: appendUnique(previous.items, page.items),
              nextCursor: page.nextCursor,
            }
          : previous,
      )
      setMore({ status: 'idle' })
    } catch (error) {
      if (controller.signal.aborted) return

      setMore({ status: 'error', message: describeError(error) })
    } finally {
      if (moreRequest.current.controller === controller) moreRequest.current.controller = null
    }
  }

  return { filter, setFilter, state, more, reload, loadMore }
}

/**
 * The list is keyed by work (R-7), and React keys must stay unique even if a status changed
 * between two pages and the server's order shifted under the cursor.
 */
function appendUnique(items: ReadingListItem[], page: ReadingListItem[]): ReadingListItem[] {
  const seen = new Set(items.map((item) => item.work.id))

  return [...items, ...page.filter((item) => !seen.has(item.work.id))]
}
