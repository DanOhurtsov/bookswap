/**
 * Settings for external title search.
 *
 * Read through functions for the same reason as in `lookup.config.ts`: values
 * are taken inside service methods, i.e. while a request is being handled, once
 * `ConfigModule` has certainly loaded `.env`.
 */

/** Every source gets its own deadline — a slow Open Library must not hold Google Books. */
const DEFAULT_TIMEOUT_MS = 4_000

/**
 * TTL for a cached successful answer.
 *
 * Deliberately shorter than the ISBN cache (30 days). There the key is an ISBN
 * and the answer barely changes. Here the key is a search string, and title
 * results shift every time a source indexes something new; an hour balances
 * "do not hit the provider with the same query" against "do not show yesterday's
 * results".
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60_000

/** How many distinct queries to keep. Entries are evicted LRU. */
const DEFAULT_CACHE_MAX_ENTRIES = 500

/**
 * Minimum interval between two calls to ONE source from this process.
 *
 * Open Library documents 1 request/s for unidentified clients and 3 for those
 * sending a `User-Agent` with a contact
 * (https://openlibrary.org/developers/api). Our `User-Agent` does carry a
 * contact (`lookupUserAgentHeaders`, `CATALOG_LOOKUP_CONTACT`), but the default
 * here is 1000 ms — the more conservative of the two figures: the provider-side
 * limit is shared by all of our traffic, while `@Throttle` on the endpoint
 * counts EVERY client separately and therefore does not bound our total
 * outbound rate at all.
 */
const DEFAULT_MIN_INTERVAL_MS = 1_000

function fromEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function externalSearchTimeoutMs(): number {
  return fromEnv('CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
}

export function externalSearchCacheTtlMs(): number {
  return fromEnv('CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS)
}

export function externalSearchCacheMaxEntries(): number {
  return fromEnv('CATALOG_EXTERNAL_SEARCH_CACHE_MAX_ENTRIES', DEFAULT_CACHE_MAX_ENTRIES)
}

export function externalSearchMinIntervalMs(): number {
  return fromEnv('CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS)
}
