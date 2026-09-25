'use client'

import { useEffect, useState } from 'react'
import { CATALOG_LIMITS, SEARCH_MAX_PAGE, isValidIsbn13 } from '@bookswap/shared'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { askedFor } from '@/app/lib/search-page'
import { searchExternalCatalogs } from '../api/search-external'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchReady,
  type ExternalSearchState,
} from './external-search-state'

/**
 * How many times a page that is still incomplete may be asked for again.
 *
 * Each ask reads at most one more block, and the server never reads deeper than
 * `SEARCH_MAX_PAGE` blocks — so the loop is finite by construction, and this is
 * a backstop against a server that never says `complete`, not a tuning knob.
 */
const MAX_CONTINUATIONS = SEARCH_MAX_PAGE + 1

/**
 * External title search driven by an address (`q`, `page`, `pageSize`) — the
 * external half of the add-book wizard's result list on `/catalog/new`.
 *
 * **Continuation.** The server spends at most one uncached block per request, so
 * a deep page on a cold cache comes back short with `complete: false`. This hook
 * then asks for the SAME page again — each ask reads one more block — and paints
 * the partial page while it does. It stops on `complete`, on a failure, when the
 * address changes (the request is aborted), or at `MAX_CONTINUATIONS`. A short
 * page that is not `complete` is never presented as the end of the list.
 *
 * State is stored together with the key it answers, and the current state is
 * derived during render — otherwise, while a new request is in flight, the
 * screen would show the previous answer. A stale answer reads as "still
 * searching", never as "found nothing".
 */
export function useExternalSearch(
  query: string,
  page: number,
  pageSize: number,
  /**
   * Bumped to ask the SAME address again ("Шукати" pressed on an unchanged query).
   * It is part of the key, so the previous answer stops counting as this one's.
   */
  refresh = 0,
): ExternalSearchState {
  const trimmed = query.trim()

  // A query that IS an ISBN does not go to external TITLE search. Sending
  // `intitle:"9786177585113"` asks a nonsensical question, and the local search
  // already answers an ISBN exactly.
  const enabled = trimmed.length >= CATALOG_LIMITS.queryMin && !isValidIsbn13(trimmed)

  const [result, setResult] = useState<{ asked: string; state: ExternalSearchState }>({
    asked: '',
    state: IDLE_EXTERNAL_SEARCH,
  })

  const asked = `${String(refresh)}\u0000${askedFor(trimmed, page, pageSize)}`

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()

    async function load(): Promise<void> {
      try {
        for (let attempt = 0; ; attempt += 1) {
          const response = await searchExternalCatalogs(trimmed, page, pageSize, controller.signal)

          if (controller.signal.aborted) return

          const state = externalSearchReady(response)

          if (response.complete || attempt >= MAX_CONTINUATIONS) {
            // The backstop: after this many asks the page is shown as it is.
            setResult({
              asked,
              state: state.status === 'ready' ? { ...state, complete: true } : state,
            })
            return
          }

          // Paint what we have and keep going: the person sees the partial page
          // (marked as still loading) instead of a spinner over nothing.
          setResult({ asked, state })
        }
      } catch (error) {
        // An aborted request is a superseded one, not a failure.
        if (controller.signal.aborted) return

        setResult({
          asked,
          state: { status: 'failed', message: describeAddBookError(error) },
        })
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [trimmed, page, pageSize, asked, enabled])

  if (!enabled) return IDLE_EXTERNAL_SEARCH

  // An answer to a different query, page or size is not yet an answer to this one.
  return result.asked === asked ? result.state : { status: 'loading' }
}
