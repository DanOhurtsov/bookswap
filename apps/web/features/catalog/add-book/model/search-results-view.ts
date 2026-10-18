import type { AddSearchExternalItem, AddSearchItem, AddSearchResponse } from '@bookswap/shared'
import type { NextPage } from '@/app/lib/search-page'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import {
  externalSearchBlind,
  externalSearchSettled,
  type ExternalSearchState,
} from './external-search-state'
import { nextPageWithAhead, type AheadPage } from './add-search-pages'
import { lookupCardIsRedundant } from './lookup-card'
import { searchPageView } from './search-page-view'

/** Which "nothing found" sentence applies; the wording itself belongs to the component. */
export type EmptyStateKind = 'BLIND' | 'AUTO_IDLE' | 'PLAIN'

export interface SearchResultsViewInput<TLookup> {
  /** Full search is executed (not a draft). */
  enabled: boolean
  /** The address was written by typing: the previous list may stay while the next one loads. */
  typing: boolean
  page: number
  /** Normalized ISBN when the executed query is one, else `undefined`. */
  isbn: string | undefined
  /** Local answer for the key that is in the address NOW; `undefined` while it loads or failed. */
  fresh: AddSearchResponse | undefined
  /** State of the local request that produced `fresh`. */
  requestStatus: KeyedState<unknown>['status']
  /** Last local answer of a typed search, kept on screen while the next one loads so the list does not jump. */
  stale: AddSearchResponse | undefined
  external: ExternalSearchState<AddSearchExternalItem>
  /** Typed text too short for the external sources: only an explicit search asks them (`HELD`). */
  externalHeld: boolean
  lookup: KeyedState<TLookup>
  /** The typed text has not reached the address yet (debounce or IME): the list is about to change. */
  localPending: boolean
  /** What the shared cache already holds for the NEXT page of this same search (`nextPageWithAhead`). */
  ahead: AheadPage
}

export interface SearchResultsView<TLookup> {
  /** What the list shows: the fresh answer, or for a typed search the previous one while the next loads. */
  response: AddSearchResponse | undefined
  items: AddSearchItem[]
  externalItems: AddSearchExternalItem[]
  /** The exact-ISBN card would repeat an edition that is already in the list. */
  redundantLookup: boolean
  lookupCard: TLookup | undefined
  /** What the controls promise about the next page: this page's answer, sharpened by the page loaded ahead. */
  next: NextPage
  /** What this page's own answer promises: it drives the loading ahead, which must not feed on itself. */
  pageNext: NextPage
  currentHasRows: boolean
  /**
   * This page is final: the fresh local answer, the external half settled, the ISBN lookup done and no
   * typed text on its way. Only then is "nothing found" said and are the pages ahead loaded.
   */
  settled: boolean
  /** "Nothing found" notice may be considered; see `searchResultsView`. */
  emptyState: EmptyStateKind | undefined
  /** The page is empty because it is past the last one. */
  pageEmpty: boolean
  /** The local half is still coming: its request is in flight, or the typed text is not in the address yet. */
  localLoading: boolean
  showPagination: boolean
}

/**
 * Everything the add-book result list derives from the two halves of the search and the ISBN lookup.
 *
 * `settled` here is deliberately NOT `searchPageView().finished`. That one trusts any local answer;
 * this one requires the FRESH answer, because a stale list kept on screen while the next request is
 * in flight (or shown for text that is not in the address yet) must never say "nothing found". It
 * also waits for the ISBN lookup and for the typed text to reach the address (`localPending`).
 *
 * The controls belong to the fresh answer only: a stale list's page links would promise pages of a
 * query that is not the one in the address.
 */
export function searchResultsView<TLookup>(
  input: SearchResultsViewInput<TLookup>,
): SearchResultsView<TLookup> {
  const {
    enabled,
    typing,
    page,
    isbn,
    fresh,
    requestStatus,
    stale,
    external,
    externalHeld,
    lookup,
    localPending,
    ahead,
  } = input
  const response = fresh ?? (typing ? stale : undefined)
  const showingStale = fresh === undefined && response !== undefined
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
  const settled =
    fresh !== undefined &&
    externalSearchSettled(external) &&
    lookup.status !== 'loading' &&
    !localPending
  const nothing = items.length === 0 && externalItems.length === 0 && lookupCard === undefined
  const nothingFound = settled && nothing

  return {
    response,
    items,
    externalItems,
    redundantLookup,
    lookupCard,
    // A stale list's page is another query's: what lies after it says nothing about this one.
    next: showingStale ? pageView.next : nextPageWithAhead(pageView.next, ahead),
    pageNext: pageView.next,
    currentHasRows: pageView.currentHasRows,
    settled,
    emptyState: nothingFound && page === 1 ? emptyStateKind(externalHeld, external) : undefined,
    pageEmpty: enabled && nothingFound && page > 1,
    localLoading: requestStatus === 'loading' || localPending,
    showPagination: enabled && requestStatus !== 'idle' && !showingStale,
  }
}

function emptyStateKind(
  externalHeld: boolean,
  external: ExternalSearchState<unknown>,
): EmptyStateKind {
  if (externalSearchBlind(external)) return 'BLIND'

  return externalHeld ? 'AUTO_IDLE' : 'PLAIN'
}
