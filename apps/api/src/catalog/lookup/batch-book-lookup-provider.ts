import type { BookLookupResult } from '@bookswap/shared'

/**
 * Stage 8f-2, R7: the port a CSV preview resolves many ISBNs through.
 *
 * Not a loop over {@link BookLookupProvider}: the single-ISBN port answers one
 * question with one result, and an import asking it 200 times is exactly what
 * R7 and the providers' own guidelines forbid. This port answers the whole set
 * at once, so the implementation is free to batch what can be batched and to
 * spend a bounded budget on what cannot.
 *
 * Three outcomes, never two. "No provider knew this ISBN" and "we could not
 * finish asking" are different answers: the first is a fact about the book, the
 * second is a fact about today's network, and collapsing them would tell a
 * person their book does not exist because a server was slow.
 */
export interface BatchBookLookupProvider {
  lookupMany(isbns: readonly string[], signal: AbortSignal): Promise<BatchBookLookupOutcome>
}

/** Why an ISBN has no answer yet. Every reason here is worth retrying. */
export type BatchLookupUnavailableReason = 'PROVIDER_ERROR' | 'TIMEOUT' | 'BUDGET_EXHAUSTED'

export interface BatchBookLookupOutcome {
  /** ISBNs a provider described. */
  found: Map<string, BookLookupResult>
  /** ISBNs whose search ran to completion everywhere and produced nothing. */
  notFound: Set<string>
  /** ISBNs the search could not finish for — never merged into `notFound`. */
  unavailable: Map<string, BatchLookupUnavailableReason>
}

/** DI-токен: інтерфейс TypeScript не існує в рантаймі. */
export const BATCH_BOOK_LOOKUP_PROVIDER = 'BATCH_BOOK_LOOKUP_PROVIDER'
