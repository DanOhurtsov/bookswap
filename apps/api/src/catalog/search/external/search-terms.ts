/**
 * Splitting a search query into the terms sent to a provider's FIELD-RESTRICTED
 * query.
 *
 * Deliberately not `comparableTokens` from `@bookswap/shared`, and the
 * difference matters. That fold runs NFKD and strips combining marks, which is
 * right for comparing two strings we already hold but destroys Ukrainian text
 * on the way out: `ї` decomposes to `і`, `й` to `и`, so "Київ" would leave here
 * as "киів" and no catalog would find it. What goes to a provider must keep the
 * characters the person typed; `comparableTokens` is for judging what comes
 * back.
 *
 * The split itself is on everything that is not a letter or a digit, so
 * punctuation, quotes and stray whitespace never reach the provider's query
 * language. That is also what makes quoting the terms safe downstream: a term
 * can contain no quote, colon, parenthesis or backslash to escape.
 */

/**
 * Upper bound on terms in one provider query.
 *
 * `q` is already length-bounded (`CATALOG_LIMITS.queryMax`), so this is not
 * about request size: every extra term is another clause the provider must
 * intersect, and past a handful the query stops narrowing and starts returning
 * nothing at all. A title long enough to hit this is matched on its first eight
 * words, and the relevance gate still judges the whole query.
 */
export const MAX_QUERY_TERMS = 8

/** Letters and digits stay exactly as typed; everything else is a separator. */
export function searchTerms(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term !== '')
    .slice(0, MAX_QUERY_TERMS)
}
