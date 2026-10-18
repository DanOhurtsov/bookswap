'use client'

import {
  CATALOG_LIMITS,
  SEARCH_MAX_PAGE,
  isValidIsbn13,
  normalizeIsbn13,
  type AddSearchExternalItem,
  type AddSearchResponse,
  type BookLookupResult,
} from '@bookswap/shared'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchAddress } from '@/app/lib/search-page'
import { useKeyedRequest, type KeyedState } from '@/app/lib/use-keyed-request'
import { useCachedQueryState, usePagesAhead } from '@/app/lib/use-pages-ahead'
import { lookupIsbn } from '../api/add-search'
import {
  addSearchExternalQuery,
  addSearchKeyOf,
  addSearchLocalQuery,
  loadAddSearchPage,
  type AddSearch,
  type ExternalPage,
} from './add-search-pages'
import { normalizeQuery } from './auto-search'
import { externalGateOf, externalHalfOf } from './external-gate'
import { externalSearchBlind, type ExternalSearchState } from './external-search-state'
import { searchResultsView, type SearchResultsView } from './search-results-view'
import { useLastReady } from './use-last-ready'

export interface AddSearchResultsInput {
  viewerId: string
  address: SearchAddress
  /** Bumped by «Шукати» on an unchanged query: the same page is asked again. */
  refresh: number
  /** See `AutoSearch.externalReleased`. */
  externalReleased: string | undefined
  /** See `AutoSearch.localPending`. */
  localPending: boolean
  /** See `SearchAddressSync.typed`. */
  typing: boolean
}

export interface AddSearchResults {
  view: SearchResultsView<BookLookupResult>
  /** The local half of the page in the address. */
  request: KeyedState<AddSearchResponse>
  external: ExternalSearchState<AddSearchExternalItem>
  lookup: KeyedState<BookLookupResult>
  /** Normalized ISBN when the executed query is one. */
  isbn: string | undefined
  /** The executed query — the address's `q`, trimmed. */
  query: string
  /** A search is executed: the address holds a query long enough to search. */
  enabled: boolean
}

/**
 * The add-book search for the address (BS-134): the page in the address — its local half at once, its
 * external half once `externalGateOf` opens — the exact ISBN lookup on the first page, and the two pages
 * after it loaded in the background through the same cache once this one is final.
 */
export function useAddSearchResults(input: AddSearchResultsInput): AddSearchResults {
  const { viewerId, address, refresh } = input
  const queryClient = useQueryClient()
  const query = address.q.trim()
  const enabled = query.length >= CATALOG_LIMITS.queryMin
  const isbn = isValidIsbn13(query) ? normalizeIsbn13(query) : undefined
  const { pageSize } = address
  const gate = externalGateOf({
    query,
    normalized: normalizeQuery(address.q),
    released: input.externalReleased,
  })
  const externalAsked = gate === 'OPEN'
  const search: AddSearch = { viewerId, q: query, pageSize, refresh }
  const localOptions = addSearchLocalQuery(search, address.page)
  const local = useQuery({ ...localOptions, queryFn: enabled ? localOptions.queryFn : skipToken })
  const externalOptions = addSearchExternalQuery(search, address.page)
  const externalAnswer = useQuery({
    ...externalOptions,
    queryFn: externalAsked ? externalOptions.queryFn : skipToken,
  })
  // ISBN search: an exact match in external sources, when our catalog has no such edition yet.
  const lookup = useKeyedRequest(
    isbn !== undefined && address.page === 1 ? `${String(refresh)}\u0000isbn:${isbn}` : undefined,
    (signal) => lookupIsbn(isbn ?? '', signal),
  )
  const request = keyedStateOf(enabled, local)
  const fresh = request.status === 'ready' ? request.value : undefined
  const stale = useLastReady(fresh, input.typing && address.page === 1)
  const external = externalHalfOf(gate, externalAnswer)
  // The next page of THIS search, as far as it is already loaded: read from the cache, never fetched here.
  const nextPage = address.page < SEARCH_MAX_PAGE ? address.page + 1 : undefined
  const aheadLocal = useCachedQueryState<AddSearchResponse>(
    enabled && nextPage !== undefined ? addSearchLocalQuery(search, nextPage).queryKey : undefined,
  )
  const aheadExternal = useCachedQueryState<ExternalPage>(
    externalAsked && nextPage !== undefined
      ? addSearchExternalQuery(search, nextPage).queryKey
      : undefined,
  )
  const view = searchResultsView({
    enabled,
    typing: input.typing,
    page: address.page,
    isbn,
    fresh,
    requestStatus: request.status,
    stale,
    external,
    externalHeld: gate === 'HELD',
    lookup,
    localPending: input.localPending,
    ahead: { local: aheadLocal, external: aheadExternal, externalAsked },
  })
  const searchKey = enabled ? addSearchKeyOf(search) : undefined
  usePagesAhead({
    search: searchKey,
    page: address.page,
    // A page no external source answered starts nothing in the background: the next would ask them for nothing.
    ready: view.settled && !externalSearchBlind(external),
    next: view.pageNext,
    // Read exactly as the page on screen: both halves, the external one only once it is asked.
    load: (page) => loadAddSearchPage(queryClient, { search, page, external: externalAsked }),
    asks: externalAsked ? 'local+external' : 'local',
  })

  return { view, request, external, lookup, isbn, query, enabled }
}

function keyedStateOf<T>(
  enabled: boolean,
  result:
    { status: 'pending' } | { status: 'error'; error: unknown } | { status: 'success'; data: T },
): KeyedState<T> {
  if (!enabled) return { status: 'idle' }
  if (result.status === 'success') return { status: 'ready', value: result.data }
  if (result.status === 'error') return { status: 'error', error: result.error }

  return { status: 'loading' }
}
