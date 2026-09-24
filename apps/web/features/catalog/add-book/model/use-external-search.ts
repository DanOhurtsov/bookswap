'use client'

import { useEffect, useState } from 'react'
import { CATALOG_LIMITS, isValidIsbn13 } from '@bookswap/shared'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { searchExternalCatalogs } from '../api/search-external'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchReady,
  type ExternalSearchState,
} from './external-search-state'

/**
 * External title search driven by a query that lives in the URL.
 *
 * This is the `/catalog` half of external search. The wizard's `SearchStep`
 * keeps its own trigger and deliberately so: there the search starts from a
 * form submit or a barcode scan, and it has to stay in step with the scanner,
 * with `entryMethod` and with invalidating a duplicate check already in flight.
 * Everything that decides what the user actually sees is shared — the same
 * request (`searchExternalCatalogs`), the same state type, the same relevance
 * and deduplication (`buildUnifiedResults`), the same cards and the same source
 * status line. Only the moment of asking differs.
 *
 * State is stored together with the query it answers and the current state is
 * derived during render — the same idiom as `useCatalogSearch`, and for the
 * same reason: otherwise, for as long as a new query is in flight, the screen
 * shows the PREVIOUS query's external results under the new word.
 */
export function useExternalSearch(query: string): ExternalSearchState {
  const trimmed = query.trim()

  // A query that IS an ISBN does not go to external TITLE search. Sending
  // `intitle:"9786177585113"` asks a nonsensical question, and the local search
  // already answers an ISBN exactly. This mirrors the wizard, where
  // `/catalog/lookup` owns that case.
  const enabled = trimmed.length >= CATALOG_LIMITS.queryMin && !isValidIsbn13(trimmed)

  const [result, setResult] = useState<{ query: string; state: ExternalSearchState }>({
    query: '',
    state: IDLE_EXTERNAL_SEARCH,
  })

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()

    async function load(): Promise<void> {
      try {
        const response = await searchExternalCatalogs(trimmed, controller.signal)

        setResult({ query: trimmed, state: externalSearchReady(response) })
      } catch (error) {
        // An aborted request is a superseded one, not a failure: reporting it
        // would paint "external catalogs did not answer" over a search the
        // person has already replaced.
        if (controller.signal.aborted) return

        setResult({
          query: trimmed,
          state: { status: 'failed', message: describeAddBookError(error) },
        })
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [trimmed, enabled])

  if (!enabled) return IDLE_EXTERNAL_SEARCH

  // An answer to a different query is not yet an answer to this one — and it
  // must read as "still searching", never as "found nothing".
  return result.query === trimmed ? result.state : { status: 'loading' }
}
