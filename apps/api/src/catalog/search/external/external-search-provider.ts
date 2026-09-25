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
 * An implementation reads ONE block of its own stream (see
 * {@link ExternalSearchBlock}) and does NOT throw on "found nothing" — that is
 * an empty array. Throwing is for an answer we cannot use (network, 5xx, a body
 * of the wrong shape): the difference between "it is not there" and "we could
 * not ask" reaches the user, and collapsing the second into the first is not
 * allowed.
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
    block: ExternalSearchBlock,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchBlockResult>
}

/**
 * Which slice of the provider's own stream to read — in RAW records, before the
 * relevance gate.
 *
 * Deliberately a block of the source stream rather than a page of the result
 * list, and the difference is the whole of `docs/plan/stage-9-search-pagination.md`:
 *
 * - **The offset must be a pure function of the page number.** The address bar
 *   carries `?page=3`, and a direct link to it has no cursor from page 2 to
 *   continue from. An opaque cursor is therefore impossible here, not merely
 *   unnecessary.
 * - **A block is much wider than a page.** Cutting the outbound request down to
 *   a page's worth would leave 2–3 raw records per query across four queries,
 *   and the relevance gate would routinely reduce that to nothing. Wider blocks
 *   also mean the pages inside one block cost no outbound call at all — they
 *   come from the cache.
 * - **Nothing read is ever discarded.** Every gated record of a block enters the
 *   pool and gets a page; the provider does not truncate.
 *
 * A provider whose stream is several queries (Google Books has no boolean OR,
 * so one search is up to three) applies the SAME offset to each of them: a union
 * has no single cursor.
 */
export interface ExternalSearchBlock {
  /** 0-based: which block of `size` raw records to read. */
  readonly index: number
  /** How many raw records ONE outbound query of this block reads. */
  readonly size: number
}

export interface ExternalSearchBlockResult {
  /** What survived the relevance gate, in the provider's own order. */
  results: ExternalSearchResult[]
  /**
   * Does the provider's stream end at or before this block's end?
   *
   * An OBSERVATION, never an estimate: Open Library reports an exact `numFound`,
   * and Google Books is judged by whether it returned fewer records than asked —
   * its own `totalItems` is known to be unstable between identical requests and
   * is not consulted at all.
   *
   * `false` when unknown (a query of the block failed): the service may then
   * spend a block it did not have to, which is cheaper than stopping a page
   * short because one query happened to fail.
   *
   * This is NOT the user-facing "has more": raw records existing says nothing
   * about any of them passing the relevance gate. That answer is computed by the
   * service, from records it is already holding.
   */
  exhausted: boolean
  /**
   * Set when the block is INCOMPLETE: a sub-request of the provider's plan failed
   * (or was skipped past the deadline) while its siblings answered. The records
   * that did arrive are kept in `results`, but the block must not pass for a full
   * answer — the service reports the source as not `OK` for this request and the
   * cache refuses to store the block, so the next attempt asks again instead of
   * serving a half-answer for an hour.
   *
   * Absent means every sub-request answered. A provider whose sub-requests ALL
   * failed does not use this; it throws, as before.
   */
  partialFailure?: Error
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

/** The deadline ran out — as opposed to the provider failing. Classified as `TIMEOUT`. */
export class ExternalSearchTimeoutError extends Error {}

/** The provider answered, but not with something we can rely on (network, 5xx, broken JSON). */
export class ExternalSearchProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalSearchProviderError'
  }
}
