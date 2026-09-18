const DEFAULT_TIMEOUT_MS = 5_000

/** R3: 30 днів — довше за це кешований запис вважається простроченим. */
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60_000
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000

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
