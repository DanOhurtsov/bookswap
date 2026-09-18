const DEFAULT_TIMEOUT_MS = 5_000

/** R3: 30 днів — довше за це кешований запис вважається простроченим. */
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60_000
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000

/** R7a: distinct ISBNs per preview allowed to reach the single-ISBN providers. */
const DEFAULT_FALLBACK_BUDGET = 50
const DEFAULT_FALLBACK_CONCURRENCY = 4

/** No version and no URL invented here — just the application, plus a contact when configured. */
const USER_AGENT_PRODUCT = 'BookSwap'

/**
 * `common/rate-limit.config.ts` читає `@Throttle`-значення лінькво через
 * функцію, бо ті обчислюються при декоруванні контролера — до
 * `ConfigModule.forRoot()`. Тут такої проблеми немає: обидва значення
 * читаються всередині методів сервіса, тобто вже під час обробки запиту,
 * коли `ConfigModule` гарантовано підвантажив `.env` у `process.env`.
 */
function fromEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** DoD 7b: «timeout на зовнішній запит (env, дефолт 5s) → 504». */
export function lookupTimeoutMs(): number {
  return fromEnv('CATALOG_LOOKUP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
}

/** R3: TTL кешу зовнішніх відповідей. */
export function lookupCacheTtlMs(): number {
  return fromEnv('CATALOG_LOOKUP_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS)
}

/** Unknown ISBNs are cached briefly so a newly indexed edition is discovered soon. */
export function lookupNegativeCacheTtlMs(): number {
  return fromEnv('CATALOG_LOOKUP_NEGATIVE_CACHE_TTL_MS', DEFAULT_NEGATIVE_CACHE_TTL_MS)
}

/**
 * Stage 8f-2, R7a (agreed): after the local catalog, the cache and the batched
 * Open Library call, at most this many distinct ISBNs of ONE preview may fall
 * through to the single-ISBN providers (Google Books, ISBNdb). The budget counts
 * ISBNs, not HTTP calls — two fallback providers can mean up to twice as many
 * requests. Rows beyond it get a retryable `LOOKUP_UNAVAILABLE`, never
 * "not found".
 */
export function lookupFallbackBudget(): number {
  return fromEnv('CATALOG_LOOKUP_FALLBACK_BUDGET', DEFAULT_FALLBACK_BUDGET)
}

/** How many fallback ISBNs may be in flight at once. */
export function lookupFallbackConcurrency(): number {
  return fromEnv('CATALOG_LOOKUP_FALLBACK_CONCURRENCY', DEFAULT_FALLBACK_CONCURRENCY)
}

/**
 * R7: production identifies itself to Open Library with a contact address.
 *
 * A missing contact is NOT masked with a default personal address — the header
 * then carries the application name alone. Inventing someone's email here would
 * point a provider's abuse reports at a person who never agreed to receive them.
 */
export function lookupUserAgentHeaders(): Record<string, string> {
  const contact = process.env.CATALOG_LOOKUP_CONTACT?.trim()
  const suffix = contact === undefined || contact === '' ? '' : ` (${contact})`

  return { 'User-Agent': `${USER_AGENT_PRODUCT}${suffix}` }
}
