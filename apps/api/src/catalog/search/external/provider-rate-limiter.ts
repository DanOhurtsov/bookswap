import { Injectable } from '@nestjs/common'
import type { BookLookupSource } from '@bookswap/shared'
import {
  MAX_RATE_LIMIT_COOLDOWN_MS,
  MIN_RATE_LIMIT_COOLDOWN_MS,
  externalRateLimitCooldownMs,
  externalSearchMinIntervalMs,
} from './external-search.config'

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

  /** When the last call to this source started — what a suggestion's own gap is measured from. */
  private readonly lastStartedAt = new Map<BookLookupSource, number>()

  /** The source asked us to back off (HTTP 429): nothing is sent before this instant. */
  private readonly cooldownUntil = new Map<BookLookupSource, number>()

  /**
   * Reserves a slot and waits for it. `maxWaitMs` keeps that wait inside the
   * request's own deadline — waiting longer is pointless, since the call would
   * return after the answer had already gone out.
   */
  async acquire(source: BookLookupSource, maxWaitMs: number): Promise<void> {
    const interval = externalSearchMinIntervalMs()
    const now = Date.now()
    // A cooldown after a 429 is a hard floor under every call, whatever the interval says.
    const earliest = Math.max(
      this.nextAvailableAt.get(source) ?? 0,
      this.cooldownUntil.get(source) ?? 0,
    )
    const wait = Math.max(0, earliest - now)

    if (wait > maxWaitMs) throw new ProviderRateLimitedError(source)

    // The slot is taken BEFORE waiting, not after: otherwise two calls arriving
    // together would compute the same `wait` and start at the same moment.
    this.nextAvailableAt.set(source, Math.max(now, earliest) + interval)
    this.lastStartedAt.set(source, Math.max(now, earliest))

    if (wait === 0) return

    await new Promise((resolve) => setTimeout(resolve, wait))
  }

  /**
   * The slot for a SUGGESTION: only a free one, never a queue, and never closer than `minGapMs` to the
   * previous call.
   *
   * Suggestions are a convenience, so they yield: a refusal costs the person nothing but a shorter
   * list, whereas a suggestion that waited for a slot would delay the full search somebody explicitly
   * asked for. A refused attempt takes nothing, so refusals do not push the next slot away.
   */
  tryAcquire(source: BookLookupSource, minGapMs: number): void {
    const now = Date.now()
    const free = Math.max(
      this.nextAvailableAt.get(source) ?? 0,
      this.cooldownUntil.get(source) ?? 0,
    )
    const gapEnds = (this.lastStartedAt.get(source) ?? 0) + minGapMs

    if (free > now || gapEnds > now) throw new ProviderRateLimitedError(source)

    this.nextAvailableAt.set(source, now + externalSearchMinIntervalMs())
    this.lastStartedAt.set(source, now)
  }

  /**
   * The source answered 429: leave it alone for `retryAfterMs` (clamped), whoever asks next.
   * Honouring the provider's own figure is the point; there is no automatic retry anywhere, so the
   * next call happens only when a person types again, and only once this has passed.
   */
  penalize(source: BookLookupSource, retryAfterMs: number | undefined): void {
    const requested = retryAfterMs ?? externalRateLimitCooldownMs()
    const cooldown = Math.min(
      Math.max(requested, MIN_RATE_LIMIT_COOLDOWN_MS),
      MAX_RATE_LIMIT_COOLDOWN_MS,
    )
    const until = Date.now() + cooldown

    this.cooldownUntil.set(source, Math.max(this.cooldownUntil.get(source) ?? 0, until))
  }

  /** Tests need a clean slate; never called in production. */
  clear(): void {
    this.nextAvailableAt.clear()
    this.lastStartedAt.clear()
    this.cooldownUntil.clear()
  }
}
