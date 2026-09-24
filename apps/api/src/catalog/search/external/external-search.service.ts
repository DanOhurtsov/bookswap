import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  EXTERNAL_SEARCH_LIMIT,
  type ExternalSearchResponse,
  type ExternalSearchResult,
  type ExternalSearchSourceReport,
  type ExternalSearchSourceStatus,
} from '@bookswap/shared'
import { runWithTimeout } from '../../lookup/lookup-timeout'
import { ExternalSearchCache, externalSearchCacheKey } from './external-search.cache'
import { externalSearchTimeoutMs } from './external-search.config'
import {
  EXTERNAL_SEARCH_PROVIDERS,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { mergeResults, type RankedResult } from './merge-external-results'
import { ProviderRateLimitedError, ProviderRateLimiter } from './provider-rate-limiter'

/** Internal marker: the deadline ran out, the provider did not fail. */
class ExternalSearchTimeoutError extends Error {}

/**
 * Title search across external catalogs (agreed extension of §6.3; see
 * `docs/plan/stage-9-external-title-search.md`).
 *
 * Three properties are the reason this service exists apart from the providers:
 *
 * 1. **Sources are queried in parallel and independently.** Each has its own
 *    deadline, so a slow Open Library does not hold up Google Books. One
 *    failing does NOT turn into a failed request — the answer stays 200 and
 *    shows which source did not reply.
 * 2. **"Found nothing" and "could not ask" never blur together.** Every source
 *    reports its own status; an empty `results` with a non-`OK` status means
 *    "unknown", not "absent". Without that split the user would conclude the
 *    book does not exist when in fact nobody managed to look.
 * 3. **The provider's rate limit is held at the process boundary.** `@Throttle`
 *    on the endpoint counts each client separately and does not bound our total
 *    outbound traffic at all — `ProviderRateLimiter` does.
 *
 * Local search is deliberately absent here: `SearchCandidatesService` already
 * does it and must answer regardless of whether external sources are alive at
 * all. The client issues both requests in parallel (`search-add-book.ts`), so
 * local results appear while the external ones are still in flight.
 */
@Injectable()
export class ExternalSearchService {
  private readonly logger = new Logger(ExternalSearchService.name)

  constructor(
    @Inject(EXTERNAL_SEARCH_PROVIDERS)
    private readonly providers: readonly ExternalSearchProvider[],
    private readonly cache: ExternalSearchCache,
    private readonly limiter: ProviderRateLimiter,
  ) {}

  async search(query: string): Promise<ExternalSearchResponse> {
    const limit = EXTERNAL_SEARCH_LIMIT

    // `allSettled` is unnecessary: `askProvider` never throws — it returns a
    // status. A provider that fell over owes us a row in the report, not silence.
    const outcomes = await Promise.all(
      this.providers.map(async (provider) => this.askProvider(provider, query, limit)),
    )

    const ranked: RankedResult[] = []
    const sources: ExternalSearchSourceReport[] = []

    for (const outcome of outcomes) {
      sources.push({ source: outcome.source, status: outcome.status })

      outcome.results.forEach((result, rank) => {
        ranked.push({ result, rank })
      })
    }

    return { results: mergeResults(query, ranked, limit), sources }
  }

  /**
   * One provider: cache → rate limit → deadline → normalized status.
   *
   * The order matters. A cache hit spends neither a rate-limiter slot nor the
   * deadline — it never leaves the process at all. Waiting for a slot sits
   * INSIDE `runWithTimeout` on purpose: otherwise a call could spend the whole
   * deadline queueing and only then start counting its own.
   */
  private async askProvider(
    provider: ExternalSearchProvider,
    query: string,
    limit: number,
  ): Promise<{
    source: ExternalSearchProvider['source']
    status: ExternalSearchSourceStatus
    results: ExternalSearchResult[]
  }> {
    const key = externalSearchCacheKey(provider.source, query, limit)

    try {
      const results = await this.cache.resolve(key, async () => {
        const timeoutMs = externalSearchTimeoutMs()

        const outcome = await runWithTimeout(timeoutMs, async (signal) => {
          const context: ExternalSearchContext = {
            signal,
            // Handed to the provider rather than taken once here, because a
            // provider may need a second field-restricted query to answer one
            // search (Google Books has no OR). The limit is per source and has
            // to count both calls.
            acquire: async () => this.limiter.acquire(provider.source, timeoutMs),
          }

          return provider.search(query, limit, context)
        })

        if (outcome.kind === 'timeout') throw new ExternalSearchTimeoutError()
        if (outcome.kind === 'error') throw outcome.error

        return outcome.value
      })

      return { source: provider.source, status: 'OK', results }
    } catch (error) {
      const status = classify(error)

      // `warn`, not `error`: an unreachable external source is an expected
      // state the user sees in the response, not a fault of this service.
      // Our own throttle says so explicitly, so nobody goes debugging the
      // provider for back-pressure we applied ourselves.
      this.logger.warn(
        `External search in ${provider.source} failed (${status}): ` + describe(error),
      )

      return { source: provider.source, status, results: [] }
    }
  }
}

function classify(error: unknown): ExternalSearchSourceStatus {
  if (error instanceof ExternalSearchTimeoutError) return 'TIMEOUT'
  if (error instanceof ProviderRateLimitedError) return 'RATE_LIMITED'

  return 'ERROR'
}

function describe(error: unknown): string {
  if (error instanceof ExternalSearchTimeoutError) return 'deadline exceeded'

  return String(error)
}
