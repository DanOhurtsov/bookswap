import type { ExternalSearchResult } from '@bookswap/shared'

/**
 * Port for external title search (§6.3 step 1 extension; see
 * `docs/plan/stage-9-external-title-search.md`).
 *
 * A separate port, not a second method on `BookLookupProvider`. That one
 * answers "what is this ISBN" and has exactly one answer; this one answers
 * "which books are called that" and has a list. Gluing them into one interface
 * would force every provider to implement both — and ISBNdb takes no part in
 * title search at all.
 *
 * An implementation returns at most `limit` records and does NOT throw on
 * "found nothing" — that is an empty array. Throwing is for an answer we cannot
 * use (network, 5xx, a body of the wrong shape): the difference between "it is
 * not there" and "we could not ask" reaches the user, and collapsing the second
 * into the first is not allowed.
 *
 * Two obligations beyond that, both about searching by TITLE AND AUTHOR rather
 * than by the book's text:
 *
 * 1. The outbound query is FIELD-RESTRICTED — the provider's own title/author
 *    operators. A provider never falls back to unrestricted full text, because
 *    that is exactly what put lesson plans and test booklets in the results.
 * 2. Every record it returns has passed `relevanceOf(...).matched`. Field
 *    restriction alone does not achieve this: Google Books treats `intitle:` as
 *    a ranking hint and still answers with books whose title contains none of
 *    the words. The gate is what actually holds the line.
 */
export interface ExternalSearchProvider {
  /** Which source this is; the same code travels in a result's `sources`. */
  readonly source: ExternalSearchResult['sources'][number]

  search(
    query: string,
    limit: number,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchResult[]>
}

/**
 * What a provider needs from the service to make an outbound call.
 *
 * `acquire` exists because a provider may need more than one request to answer
 * one search: Google Books has no boolean OR, so "title only" and "title plus
 * author" are two different field-restricted queries and cannot be asked at
 * once. The rate limit is per SOURCE and must count every call, so the
 * permission to call is handed to the provider rather than taken once by the
 * service on its behalf — otherwise a second request would slip past the limit
 * uncounted.
 */
export interface ExternalSearchContext {
  /** Aborts when the provider's own deadline expires. */
  readonly signal: AbortSignal
  /**
   * Awaited immediately before EVERY outbound HTTP call. Rejects with
   * `ProviderRateLimitedError` when the wait would outlast the deadline.
   */
  acquire(): Promise<void>
}

/** DI token: a TypeScript interface does not exist at runtime. */
export const EXTERNAL_SEARCH_PROVIDERS = 'EXTERNAL_SEARCH_PROVIDERS'

/** The provider answered, but not with something we can rely on (network, 5xx, broken JSON). */
export class ExternalSearchProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalSearchProviderError'
  }
}
