import { AUTO_SEARCH_EXTERNAL_MIN_CHARS, AUTO_SEARCH_LOCAL_MIN_CHARS } from '@bookswap/shared'

/**
 * Search while typing (`/catalog/new`): thresholds and delays in one place.
 *
 * The thresholds are shared with the server (`@bookswap/shared`). The delays are the client's alone;
 * every change of the text restarts both timers. Since BS-134 typing runs the full paged search, not
 * limited suggestions.
 */
export const AUTO_LOCAL_MIN_CHARS = AUTO_SEARCH_LOCAL_MIN_CHARS
export const AUTO_EXTERNAL_MIN_CHARS = AUTO_SEARCH_EXTERNAL_MIN_CHARS

/** Pause after the last change of the text before the search (its first page, our catalog). */
export const AUTO_LOCAL_DELAY_MS = 350
/** Pause after the last change of the text before the search's external half is asked. */
export const AUTO_EXTERNAL_DELAY_MS = 900

/**
 * Before BS-134 addresses of limited suggestions carried `auto=1`. Nothing writes it any more; an old
 * link with it opens the full search of the same `q`, and the address is corrected without it.
 */
export const LEGACY_AUTO_PARAM = 'auto'

/**
 * The normalized query: NFC, runs of whitespace collapsed, edges trimmed.
 *
 * Normalized strings are what is compared: «кобзар », «кобзар» and «кобзар  » are one query, and a
 * change of whitespace alone starts no new search.
 */
export function normalizeQuery(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}
