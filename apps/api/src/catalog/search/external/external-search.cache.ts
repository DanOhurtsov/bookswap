import { Injectable } from '@nestjs/common'
import type { BookLookupSource } from '@bookswap/shared'
import {
  externalSearchCacheMaxEntries,
  externalSearchCacheTtlMs,
  externalSuggestCacheMaxEntries,
} from './external-search.config'
import type { ExternalSearchBlockResult } from './external-search-provider'

/**
 * `FULL` is the paged search, `SUGGEST` the capped auto-suggest. The mode is part of the key: a
 * suggestion is ONE field-restricted query, a full block is up to three, so the shorter answer must
 * never be served in place of the longer one.
 */
export type ExternalSearchMode = 'FULL' | 'SUGGEST'

/**
 * The cache key: source + mode + normalized query + block index + block size.
 *
 * All four parts are required. The source, because "Harry Potter" in Open
 * Library and in Google Books are different answers. The block index, because
 * the cached unit is ONE slice of the provider's stream, not the whole search —
 * that is exactly what lets a page inside an already-read block cost nothing
 * outbound. The size, because it goes into the provider request itself
 * (`limit`/`maxResults`), so an answer for 24 records is not an answer for 40,
 * and serving the first in place of the second would silently truncate.
 *
 * Normalization is local (case + whitespace) rather than via `TextNormalizer`:
 * that one goes to Postgres for `unaccent`, and paying with a database query to
 * compute the key of a cache that exists to avoid queries is backwards.
 */
export function externalSearchCacheKey(
  source: BookLookupSource,
  query: string,
  blockIndex: number,
  blockSize: number,
  mode: ExternalSearchMode = 'FULL',
): string {
  const normalized = query.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()

  return [mode, source, String(blockSize), String(blockIndex), normalized].join('\0')
}

interface CacheEntry {
  value: ExternalSearchBlockResult
  expiresAt: number
}

/**
 * Cache of external result BLOCKS — in process memory, with a TTL, a size cap
 * and coalescing of concurrent identical requests.
 *
 * **Per API instance, and gone on restart.** A deliberate first-version choice,
 * not an oversight: the existing `ExternalBookLookup` table is keyed by `isbn`
 * and cannot hold a title query, and a new table means migrating a shared
 * database for data that is disposable by nature. The same trade-off already
 * applies to the rate-limiting counter (see README). The consequence to
 * remember: with several instances each warms its own cache, so the real call
 * rate towards a provider multiplies by their count — which is why throttling
 * also lives in `ProviderRateLimiter`.
 *
 * Errors are NOT cached — neither as errors nor (least of all) as empty
 * results — and neither is a PARTIAL block (`partialFailure`): a block missing
 * one of its sub-queries is not the provider's answer, and serving it as one
 * for an hour would turn a transient failure into a hole in the results. A provider that was down for ten seconds must not become "no such
 * book" for an hour.
 */
@Injectable()
export class ExternalSearchCache {
  /**
   * `Map` preserves insertion order, so LRU falls straight out of it: a read
   * moves the entry to the end, and eviction always takes the first key.
   */
  private readonly entries = new Map<string, CacheEntry>()

  /**
   * Requests already in flight. A second call for the same key awaits the same
   * promise instead of opening a second provider call — otherwise a dozen
   * people searching for the same thing at once would produce a dozen outbound
   * requests, and the cache would not help, because none of them has been
   * written yet.
   */
  private readonly inFlight = new Map<string, Promise<ExternalSearchBlockResult>>()

  /**
   * Is this block already in hand, without asking anybody?
   *
   * The service uses it to spend at most ONE round of outbound calls per
   * request: blocks it already holds are free, and the one it does not hold is
   * the one it pays for. Reading through `read` on purpose, so an expired entry
   * counts as absent — a stale block is not "in hand".
   */
  peek(key: string): ExternalSearchBlockResult | undefined {
    return this.read(key)
  }

  async resolve(
    key: string,
    load: () => Promise<ExternalSearchBlockResult>,
  ): Promise<ExternalSearchBlockResult> {
    const cached = this.read(key)
    if (cached !== undefined) return cached

    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending

    const started = load()
      .then((value) => {
        // A partial block is served to whoever asked, but never stored: the
        // next request must ask the provider again.
        if (value.partialFailure === undefined) this.write(key, value)
        return value
      })
      .finally(() => {
        this.inFlight.delete(key)
      })

    this.inFlight.set(key, started)

    return started
  }

  /** An expired entry is dropped at once — otherwise it would hold an LRU slot. */
  private read(key: string): ExternalSearchBlockResult | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }

    // Just read means youngest: move it to the end of the eviction queue.
    this.entries.delete(key)
    this.entries.set(key, entry)

    return entry.value
  }

  private write(key: string, value: ExternalSearchBlockResult): void {
    const suggest = key.startsWith('SUGGEST\0')
    const max = suggest ? externalSuggestCacheMaxEntries() : externalSearchCacheMaxEntries()

    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + externalSearchCacheTtlMs() })

    // Each mode is evicted against its own cap, oldest first: `Map` keeps insertion order.
    let count = 0

    for (const existing of this.entries.keys()) {
      if (existing.startsWith('SUGGEST\0') === suggest) count += 1
    }

    for (const existing of this.entries.keys()) {
      if (count <= max) break
      if (existing.startsWith('SUGGEST\0') !== suggest) continue

      this.entries.delete(existing)
      count -= 1
    }
  }

  /** Tests need a clean slate; never called in production. */
  clear(): void {
    this.entries.clear()
    this.inFlight.clear()
  }
}
