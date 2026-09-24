import { ProviderRateLimitedError, ProviderRateLimiter } from './provider-rate-limiter'

describe('ProviderRateLimiter', () => {
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
  let limiter: ProviderRateLimiter

  beforeEach(() => {
    limiter = new ProviderRateLimiter()
  })

  afterEach(() => {
    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    jest.restoreAllMocks()
  })

  it('перший виклик проходить без очікування', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1000'

    const started = Date.now()
    await limiter.acquire('OPEN_LIBRARY', 5_000)

    expect(Date.now() - started).toBeLessThan(50)
  })

  it('витримує інтервал між двома викликами того самого джерела', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '60'

    await limiter.acquire('OPEN_LIBRARY', 5_000)
    const started = Date.now()
    await limiter.acquire('OPEN_LIBRARY', 5_000)

    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })

  it('різні джерела мають незалежні інтервали — Google не чекає на Open Library', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1000'

    await limiter.acquire('OPEN_LIBRARY', 5_000)
    const started = Date.now()
    await limiter.acquire('GOOGLE_BOOKS', 5_000)

    expect(Date.now() - started).toBeLessThan(50)
  })

  it('відмовляє одразу, коли чекати довелося б довше за дедлайн запиту', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '10000'

    await limiter.acquire('OPEN_LIBRARY', 5_000)

    // A growing queue would turn into invisible latency; a visible refusal is
    // honester — the source is simply reported as rate limited.
    await expect(limiter.acquire('OPEN_LIBRARY', 1_000)).rejects.toBeInstanceOf(
      ProviderRateLimitedError,
    )
  })

  it('два одночасні виклики не стартують разом — слот займається до очікування', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '40'

    const finishes: number[] = []
    await Promise.all([
      limiter.acquire('OPEN_LIBRARY', 5_000).then(() => finishes.push(Date.now())),
      limiter.acquire('OPEN_LIBRARY', 5_000).then(() => finishes.push(Date.now())),
      limiter.acquire('OPEN_LIBRARY', 5_000).then(() => finishes.push(Date.now())),
    ])

    const [first, , third] = finishes as [number, number, number]
    expect(third - first).toBeGreaterThanOrEqual(60)
  })
})
