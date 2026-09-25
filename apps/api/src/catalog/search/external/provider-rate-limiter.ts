import { Injectable } from '@nestjs/common'
import type { BookLookupSource } from '@bookswap/shared'
import { externalSearchMinIntervalMs } from './external-search.config'

/**
 * Our own back-pressure refused this call. Deliberately its own class: the
 * service maps it to `RATE_LIMITED`, never to `ERROR`, because "we throttled
 * ourselves" and "the provider is down" send a reader to different systems.
 */
export class ProviderRateLimitedError extends Error {
  constructor(readonly source: BookLookupSource) {
    super(`Own outbound rate limit for ${source} exceeded`)
    this.name = 'ProviderRateLimitedError'
  }
}

/**
 * Keeps a minimum interval between calls to one external source.
 *
 * Why this on top of the endpoint's `@Throttle`. That one counts EACH client
 * separately: a hundred different people with their own allowances produce a
 * hundred requests per second to Open Library, which documents one (three with
 * an identified `User-Agent`). The provider's limit is shared across all of our
 * traffic, so it can only be held in one place — here, on the way out of the
 * process.
 *
 * There is deliberately no queue object. A call that would have to wait longer
 * than `maxWaitMs` is refused immediately: a growing queue turns into latency
 * nobody sees, until every request starts timing out. A refusal is visible
 * instead — the source is honestly reported as rate limited, and neither local
 * results nor manual entry depend on it at all.
 *
 * State lives in process memory, like `ExternalSearchCache`: with several
 * instances each keeps its own interval and the total rate multiplies by their
 * count.
 */
@Injectable()
export class ProviderRateLimiter {
  /** The instant before which the next call to this source must not start. */
  private readonly nextAvailableAt = new Map<BookLookupSource, number>()

  /**
   * Reserves a slot and waits for it. `maxWaitMs` keeps that wait inside the
   * request's own deadline — waiting longer is pointless, since the call would
   * return after the answer had already gone out.
   */
  async acquire(source: BookLookupSource, maxWaitMs: number): Promise<void> {
    const interval = externalSearchMinIntervalMs()
    const now = Date.now()
    const earliest = this.nextAvailableAt.get(source) ?? 0
    const wait = Math.max(0, earliest - now)

    if (wait > maxWaitMs) throw new ProviderRateLimitedError(source)

    // The slot is taken BEFORE waiting, not after: otherwise two calls arriving
    // together would compute the same `wait` and start at the same moment.
    this.nextAvailableAt.set(source, Math.max(now, earliest) + interval)

    if (wait === 0) return

    await new Promise((resolve) => setTimeout(resolve, wait))
  }

  /** Tests need a clean slate; never called in production. */
  clear(): void {
    this.nextAvailableAt.clear()
  }
}
