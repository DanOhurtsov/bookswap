import {
  SEARCH_MAX_PAGE,
  type AddSearchExternalItem,
  type AddSearchResponse,
} from '@bookswap/shared'
import type { QueryClient, QueryFunctionContext, QueryKey } from '@tanstack/react-query'
import { nextPageOf, type NextPage } from '@/app/lib/search-page'
import { searchPageQueryDefaults } from '@/app/lib/use-pages-ahead'
import { searchAddExternal, searchAddItems } from '../api/add-search'
import {
  externalSearchBlind,
  externalSearchReady,
  type ExternalHalfResponse,
} from './external-search-state'

/**
 * The add-book search's pages in the shared TanStack Query cache (BS-134): the page on screen and the
 * pages loaded ahead are read through these same options, so a prepared page is reused and a request
 * in flight is joined instead of repeated.
 */

/** One resource, one key prefix (CONVENTIONS §3.9): every add-search page of every viewer. */
export const ADD_SEARCH_QUERY_KEY = ['add-search'] as const

/** Everything that decides a page's content, except the page number and the half. */
export interface AddSearch {
  /** Pages carry the viewer's ownership: another account never sees this one's cached answers. */
  viewerId: string
  /** The executed query, as sent to the server. */
  q: string
  pageSize: number
  /** Bumped to ask the same query again («Шукати» on an unchanged query). */
  refresh: number
}

export type ExternalPage = ExternalHalfResponse<AddSearchExternalItem>

export function addSearchKeyOf(search: AddSearch) {
  return [
    ...ADD_SEARCH_QUERY_KEY,
    search.viewerId,
    search.q,
    search.pageSize,
    search.refresh,
  ] as const
}

/** The local half of one page: our catalog's editions, sliced by the server. */
export function addSearchLocalQuery(search: AddSearch, page: number) {
  return {
    queryKey: [...addSearchKeyOf(search), 'local', page] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      searchAddItems(search.q, page, search.pageSize, signal),
    ...searchPageQueryDefaults<AddSearchResponse>(),
  }
}

/**
 * How many times a page that is still incomplete may be asked for again.
 *
 * Each ask reads at most one more block, and the server never reads deeper than
 * `SEARCH_MAX_PAGE` blocks — so the loop is finite by construction, and this is
 * a backstop against a server that never says `complete`, not a tuning knob.
 */
const MAX_CONTINUATIONS = SEARCH_MAX_PAGE + 1

/**
 * An external page worth keeping: complete, and every source that was asked answered (`OK`). A
 * source's failure arrives inside a successful HTTP answer (`sources`), so `complete` alone would
 * keep it for minutes after the source is back. `sources: []` — nobody was asked — is no failure.
 */
export function externalPageFinal(data: ExternalPage): boolean {
  return data.complete && data.sources.every((report) => report.status === 'OK')
}

/**
 * The external half of one page.
 *
 * **Continuation.** The server spends at most one uncached block per request, so
 * a deep page on a cold cache comes back short with `complete: false`. The page is
 * then asked for AGAIN — each ask reads one more block — and the partial page is
 * painted (written to this query's cache entry) while it does. It stops on
 * `complete`, on a failure, when the request is cancelled, or at
 * `MAX_CONTINUATIONS`, after which the page is shown as it is.
 *
 * Only a page `externalPageFinal` accepts is reused as fresh. A partial page left
 * behind by a cancellation, or one a source failed to answer for, is stale: it
 * stays on screen, and the next visit asks again — once, never in a loop.
 */
export function addSearchExternalQuery(search: AddSearch, page: number) {
  return {
    queryKey: [...addSearchKeyOf(search), 'external', page] as const,
    queryFn: async ({ signal, client, queryKey }: QueryFunctionContext<QueryKey>) => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await searchAddExternal(search.q, page, search.pageSize, signal)

        if (response.complete || attempt >= MAX_CONTINUATIONS)
          return { ...response, complete: true }
        // A cancelled continuation must not write after the cache has been reverted.
        signal.throwIfAborted()

        client.setQueryData<ExternalPage>(queryKey, response)
      }
    },
    ...searchPageQueryDefaults<ExternalPage>(externalPageFinal),
  }
}

/**
 * Loads page `page` of `search` through the shared cache — both halves at once, like the page on
 * screen, the external one only when the page on screen asks it too — and says what it promises
 * about the page after it (the same `nextPageOf` the controls use). A page no external source
 * answered promises nothing more to load ahead: the next one would only ask them again.
 */
export async function loadAddSearchPage(
  queryClient: QueryClient,
  input: { search: AddSearch; page: number; external: boolean },
): Promise<NextPage> {
  const { search, page } = input
  const [local, external] = await Promise.all([
    queryClient.fetchQuery(addSearchLocalQuery(search, page)),
    input.external ? queryClient.fetchQuery(addSearchExternalQuery(search, page)) : undefined,
  ])

  if (external !== undefined && externalSearchBlind(externalSearchReady(external))) return 'NONE'

  return nextPageOf({
    page,
    localHasMore: local.hasMore,
    externalMore: external?.more ?? 'NO',
  })
}

/** What the shared cache holds for one half of a page, as TanStack keeps it (`getQueryState`). */
export interface CachedHalf<T> {
  status: 'pending' | 'error' | 'success'
  data: T | undefined
}

/** The next page of the same search as the shared cache holds it. */
export interface AheadPage {
  local: CachedHalf<AddSearchResponse> | undefined
  external: CachedHalf<ExternalPage> | undefined
  /** Whether this search asks the external half at all (`externalGateOf` is `OPEN`). */
  externalAsked: boolean
}

/**
 * The controls' promise about page N+1, sharpened by what the pages loaded ahead already hold.
 *
 * Evidence, strongest first:
 *
 * 1. The page's own end (`NONE`, `SEARCH_MAX_PAGE` included) — never overruled.
 * 2. N+1 itself, final and empty — our catalog done, the external half complete with `more = NO`
 *    and every asked source `OK` — proves the end (`NONE`), even after page N promised it
 *    (`PROVEN`): N+1 is the later and the direct answer, N's `more = YES` only a forecast of it.
 * 3. Rows already loaded for N+1 prove it (`PROVEN`, its number is shown).
 * 4. Otherwise page N's own promise stands. Not loaded yet, partial, `UNKNOWN`, a failed source or
 *    request (429 included) prove nothing either way, and a visit to N+1 asks again.
 */
export function nextPageWithAhead(next: NextPage, ahead: AheadPage): NextPage {
  if (next === 'NONE') return next

  const { local, external } = ahead
  const rows = (local?.data?.items.length ?? 0) + (external?.data?.results.length ?? 0)

  if (rows > 0) return 'PROVEN'

  const localEnded = local?.status === 'success' && local.data !== undefined && !local.data.hasMore
  const externalEnded =
    !ahead.externalAsked ||
    (external?.status === 'success' &&
      external.data !== undefined &&
      externalPageFinal(external.data) &&
      external.data.more === 'NO')

  return localEnded && externalEnded ? 'NONE' : next
}
