import type { AddSearchExternalItem, AddSearchItem, AddSearchResponse } from '@bookswap/shared'
import type { NextPage } from '@/app/lib/search-page'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import {
  externalSearchBlind,
  externalSearchSettled,
  type ExternalSearchState,
} from './external-search-state'
import { lookupCardIsRedundant } from './lookup-card'
import { searchPageView } from './search-page-view'

/** Which "nothing found" sentence applies; the wording itself belongs to the component. */
export type EmptyStateKind = 'BLIND' | 'AUTO_IDLE' | 'PLAIN'

export interface SearchResultsViewInput<TLookup> {
  /** Full search is executed (not suggestions, not a draft). */
  enabled: boolean
  /** Address is in suggestion mode and the text is long enough to suggest. */
  autoActive: boolean
  page: number
  /** Normalized ISBN when the executed query is one, else `undefined`. */
  isbn: string | undefined
  /** Local answer for the key that is in the address NOW; `undefined` while it loads or failed. */
  fresh: AddSearchResponse | undefined
  /** State of the local request that produced `fresh`. */
  requestStatus: KeyedState<unknown>['status']
  /** Last local answer, kept on screen between suggestion requests so the list does not jump. */
  stale: AddSearchResponse | undefined
  external: ExternalSearchState<AddSearchExternalItem>
  lookup: KeyedState<TLookup>
  /** Suggestion mode: the typed text has not reached the address yet (debounce or IME). */
  localPending: boolean
}

export interface SearchResultsView<TLookup> {
  /** What the list shows: the fresh answer, or in suggestion mode the previous one while the next loads. */
  response: AddSearchResponse | undefined
  items: AddSearchItem[]
  externalItems: AddSearchExternalItem[]
  /** The exact-ISBN card would repeat an edition that is already in the list. */
  redundantLookup: boolean
  lookupCard: TLookup | undefined
  next: NextPage
  currentHasRows: boolean
  /** "Nothing found" notice may be considered; see `searchResultsView`. */
  emptyState: EmptyStateKind | undefined
  /** The page is empty because it is past the last one. */
  pageEmpty: boolean
  /** One neutral line: some external source did not answer, and no empty-state sentence already says so. */
  showUnavailableNotice: boolean
  /** The local half is still coming: its request is in flight, or (suggestions) the typed text is not in the address yet. */
  localLoading: boolean
  /** Suggestions offer the way to the full search once their answer is in. */
  showAllResults: boolean
  showPagination: boolean
}

/**
 * Everything the add-book result list derives from the two halves of the search and the ISBN lookup.
 *
 * `finished` here is deliberately NOT `searchPageView().finished`. That one trusts any local answer;
 * this one requires the FRESH answer, because a stale list kept on screen while the next request is
 * in flight (or shown for text that is not in the address yet) must never say "nothing found". It
 * also waits for the ISBN lookup, and in suggestion mode for the debounce (`localPending`).
 */
export function searchResultsView<TLookup>(
  input: SearchResultsViewInput<TLookup>,
): SearchResultsView<TLookup> {
  const {
    enabled,
    autoActive,
    page,
    isbn,
    fresh,
    requestStatus,
    stale,
    external,
    lookup,
    localPending,
  } = input
  const response = fresh ?? (autoActive ? stale : undefined)
  const items = response?.items ?? []
  const externalItems = external.status === 'ready' ? external.results : []
  const redundantLookup = isbn !== undefined && lookupCardIsRedundant(isbn, items, externalItems)
  const lookupCard =
    lookup.status === 'ready' && response !== undefined && !redundantLookup
      ? lookup.value
      : undefined
  const pageView = searchPageView({
    page,
    local: { ready: response !== undefined, hasMore: response?.hasMore ?? false },
    // The lookup card is a row of the list too: it decides whether the current page is empty.
    rowCount: items.length + externalItems.length + (lookupCard === undefined ? 0 : 1),
    external,
  })
  const finished =
    fresh !== undefined &&
    externalSearchSettled(external) &&
    lookup.status !== 'loading' &&
    !(autoActive && localPending)
  const nothing = items.length === 0 && externalItems.length === 0 && lookupCard === undefined
  const externalUnavailable =
    autoActive &&
    (external.status === 'failed' ||
      (external.status === 'ready' && external.sources.some((report) => report.status !== 'OK')))
  const nothingFound = finished && nothing

  return {
    response,
    items,
    externalItems,
    redundantLookup,
    lookupCard,
    next: pageView.next,
    currentHasRows: pageView.currentHasRows,
    emptyState:
      nothingFound && (autoActive || page === 1) ? emptyStateKind(autoActive, external) : undefined,
    pageEmpty: enabled && nothingFound && page > 1,
    showUnavailableNotice: externalUnavailable && !nothingFound,
    localLoading: requestStatus === 'loading' || (autoActive && localPending),
    showAllResults: autoActive && fresh !== undefined,
    showPagination: enabled && requestStatus !== 'idle',
  }
}

function emptyStateKind(
  autoActive: boolean,
  external: ExternalSearchState<unknown>,
): EmptyStateKind {
  if (externalSearchBlind(external)) return 'BLIND'

  return autoActive && external.status === 'idle' ? 'AUTO_IDLE' : 'PLAIN'
}
