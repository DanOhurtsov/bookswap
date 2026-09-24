import type { ExternalSearchResponse, ExternalSearchResult } from '@bookswap/shared'

/**
 * State of the "found in other catalogs" section.
 *
 * Four states, not a boolean `loading`. "Searching", "found nothing", "source
 * unavailable" and "have not searched yet" are different facts, and two of them
 * are easy to mistake for a third: an empty list during a failure would read as
 * "no such book" when in truth nobody managed to look. The type keeps them
 * apart so there is nowhere left to confuse them.
 *
 * `failed` is a failure of OUR request (network, 429, 401): the section knows
 * nothing at all. A single source being unavailable is a different matter — it
 * arrives inside a successful answer via `sources`, because the other sources
 * did reply.
 */
export type ExternalSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      results: ExternalSearchResult[]
      sources: ExternalSearchResponse['sources']
    }

export const IDLE_EXTERNAL_SEARCH: ExternalSearchState = { status: 'idle' }

export function externalSearchReady(response: ExternalSearchResponse): ExternalSearchState {
  return { status: 'ready', results: response.results, sources: response.sources }
}

/**
 * Has the external half of the search finished, one way or another?
 *
 * The empty state depends on this and on nothing else: "nothing found" may only
 * be said once every source has answered or failed. Saying it while a source is
 * still being asked states as fact something nobody has checked yet.
 */
export function externalSearchSettled(state: ExternalSearchState): boolean {
  return state.status !== 'loading'
}

/**
 * Did the external half end up knowing nothing at all?
 *
 * True when our own request failed, or when every source that was asked
 * answered with a status other than `OK`. It separates "the book is not in
 * those catalogs" from "nobody managed to look" — the same distinction the
 * state machine above exists for, at the level of the whole search.
 *
 * An empty `sources` is NOT this case: it means no source was queried, which is
 * a third thing again (an ISBN query never asks them).
 */
export function externalSearchBlind(state: ExternalSearchState): boolean {
  if (state.status === 'failed') return true
  if (state.status !== 'ready') return false

  return state.sources.length > 0 && state.sources.every((report) => report.status !== 'OK')
}
