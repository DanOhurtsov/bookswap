import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  SEARCH_MAX_PAGE,
  splitSearchPage,
  type ExternalSearchMore,
  type ExternalSearchResponse,
  type ExternalSearchResult,
  type ExternalSearchSourceReport,
  type ExternalSearchSourceStatus,
} from '@bookswap/shared'
import { runWithTimeout } from '../../lookup/lookup-timeout'
import { LocalMatches } from '../local-matches.service'
import { ExternalSearchCache, externalSearchCacheKey } from './external-search.cache'
import { externalSearchBlockSize, externalSearchTimeoutMs } from './external-search.config'
import {
  EXTERNAL_SEARCH_PROVIDERS,
  ExternalSearchTimeoutError,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { mergeResults, type RankedResult } from './merge-external-results'
import { ProviderRateLimitedError, ProviderRateLimiter } from './provider-rate-limiter'

/**
 * How deep the pool may ever be read, in blocks — also the point past which
 * `more` says `NO`.
 *
 * A guard against looping and a depth limit, not a cost control: at most ONE
 * block is fetched per request, everything before it is a free cache read.
 */
const MAX_BLOCKS = SEARCH_MAX_PAGE

/** What one source has contributed to this request so far. */
interface ProviderState {
  readonly provider: ExternalSearchProvider
  status: ExternalSearchSourceStatus
  /** The provider's stream ended — asking for a further block is pointless. */
  exhausted: boolean
  entries: RankedResult[]
}

/**
 * Paged title search across external catalogs (agreed extension of §6.3; see
 * `docs/plan/stage-9-external-title-search.md` and
 * `docs/plan/stage-9-search-pagination.md`).
 *
 * Four properties are the reason this service exists apart from the providers:
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
 * 4. **Pages are cut from a pool, not requested one page at a time.** Sources
 *    are read in wide blocks; the pool of what survived the relevance gate is
 *    what gets paged. A page inside an already-read block therefore costs no
 *    outbound call whatsoever.
 *
 * Local search is deliberately absent here: `CatalogService` already does it and
 * must answer regardless of whether external sources are alive at all. The
 * client issues both requests in parallel, so local results appear while the
 * external ones are still in flight — including when paging.
 */
@Injectable()
export class ExternalSearchService {
  private readonly logger = new Logger(ExternalSearchService.name)

  constructor(
    @Inject(EXTERNAL_SEARCH_PROVIDERS)
    private readonly providers: readonly ExternalSearchProvider[],
    private readonly cache: ExternalSearchCache,
    private readonly limiter: ProviderRateLimiter,
    private readonly local: LocalMatches,
  ) {}

  /**
   * The external part of one page of the shared list.
   *
   * **How many rows and from where** is not this service's decision:
   * `splitSearchPage` divides the page between our own catalog and this pool, and
   * the local total it needs is computed HERE, from the same materialization the
   * local endpoints use (`LocalMatches`). The client therefore fires both
   * requests at once and neither waits for the other's answer.
   *
   * The same materialization gives the ISBNs our catalog already holds among ALL
   * its matches. External records carrying one are dropped from the pool BEFORE
   * the page is cut: the page stays full instead of losing cards afterwards, and
   * a book shown as our own card on page 1 cannot resurface as an external one on
   * page 2. A filter over a fixed set keeps the pool prefix-stable.
   *
   * The loop reads block after block until the pool holds the page **plus one**
   * record — the extra record is the entire basis of `more = YES`, a record in
   * hand that passed the relevance gate and duplicate merging. "The provider
   * claims more documents exist" is not proof.
   *
   * **At most one round of outbound calls per request.** Blocks already in the
   * cache are walked for free; the first one that is missing is fetched, and
   * after that the loop stops even if the page is not full. The bound is not
   * arbitrary: a source has a single deadline (4s), the limiter holds 1s between
   * calls to it, and one Google Books block is up to three calls. A second
   * fetched block in the same request would turn a working page into a
   * `TIMEOUT`, which costs every result. What that leaves — a page short only
   * because the budget ran out — is reported honestly as `complete: false` with
   * `more: UNKNOWN`, and the client asks again; each ask reads one more block.
   */
  async search(query: string, page: number, pageSize: number): Promise<ExternalSearchResponse> {
    const matches = await this.local.rank(query, { authors: false })
    const { externalFrom, externalCount } = splitSearchPage({
      page,
      pageSize,
      localTotal: matches.works.length,
    })

    // The page is made of our own rows alone AND more of them follow: nothing to
    // ask outside, and the next page is proved by the local half.
    if (externalCount === 0 && matches.works.length > page * pageSize) {
      return { results: [], sources: [], page, pageSize, more: 'UNKNOWN', complete: true }
    }

    const known = await this.local.isbnsOf(matches.works.map((row) => row.id))
    const blockSize = externalSearchBlockSize()
    const states: ProviderState[] = this.providers.map((provider) => ({
      provider,
      status: 'OK',
      exhausted: false,
      entries: [],
    }))

    // One past the page is the proof; a page that is all local still probes one
    // record, because the NEXT page starts in the pool.
    const needed = externalFrom + externalCount + 1
    let pool: ExternalSearchResult[] = []
    let fetchSpent = false
    let blocksRead = 0

    for (let index = 0; index < MAX_BLOCKS; index += 1) {
      const active = states.filter((state) => state.status === 'OK' && !state.exhausted)

      if (active.length === 0) break

      const missing = active.filter(
        (state) =>
          this.cache.peek(
            externalSearchCacheKey(state.provider.source, query, index, blockSize),
          ) === undefined,
      )

      if (missing.length > 0) {
        if (fetchSpent) break

        fetchSpent = true
      }

      await Promise.all(active.map(async (state) => this.readBlock(state, query, index, blockSize)))
      blocksRead = index + 1

      pool = mergeResults(
        query,
        states.flatMap((state) => state.entries),
      ).filter((result) => result.isbn13 === undefined || !known.has(result.isbn13))

      if (pool.length >= needed) break
    }

    const to = externalFrom + externalCount
    const results = pool.slice(externalFrom, to)
    // Can a further block still be read? Only a source that answered `OK`, whose
    // stream did not end, and only within the depth limit.
    const canReadMore =
      blocksRead < MAX_BLOCKS && states.some((state) => state.status === 'OK' && !state.exhausted)

    const more: ExternalSearchMore = pool.length > to ? 'YES' : canReadMore ? 'UNKNOWN' : 'NO'

    return {
      results,
      sources: states.map((state): ExternalSearchSourceReport => ({
        source: state.provider.source,
        status: state.status,
      })),
      page,
      pageSize,
      more,
      // Final when full, or when there is nothing left to read. Short with more
      // to read means only the budget stopped us.
      complete: results.length === externalCount || !canReadMore,
    }
  }

  /**
   * One block from one provider: cache → rate limit → deadline → state.
   *
   * The order matters. A cache hit spends neither a rate-limiter slot nor the
   * deadline — it never leaves the process at all. Waiting for a slot sits
   * INSIDE `runWithTimeout` on purpose: otherwise a call could spend the whole
   * deadline queueing and only then start counting its own.
   *
   * A failure marks the source and stops it being asked again in this request,
   * but leaves the blocks it already delivered in the pool: a source that
   * answered twice and then broke has still shown us real books, and throwing
   * them away would be reporting a partial failure as a total one.
   */
  private async readBlock(
    state: ProviderState,
    query: string,
    index: number,
    size: number,
  ): Promise<void> {
    const key = externalSearchCacheKey(state.provider.source, query, index, size)

    try {
      const block = await this.cache.resolve(key, async () => {
        const timeoutMs = externalSearchTimeoutMs()

        const outcome = await runWithTimeout(timeoutMs, async (signal) => {
          const context: ExternalSearchContext = {
            signal,
            // Handed to the provider rather than taken once here, because a
            // provider may need several field-restricted queries to answer one
            // search (Google Books has no OR). The limit is per source and has
            // to count every one of them.
            acquire: async () => this.limiter.acquire(state.provider.source, timeoutMs),
          }

          return state.provider.search(query, { index, size }, context)
        })

        if (outcome.kind === 'timeout') throw new ExternalSearchTimeoutError()
        if (outcome.kind === 'error') throw outcome.error

        return outcome.value
      })

      state.exhausted = block.exhausted

      // A block missing part of its plan keeps what it found but is not `OK`:
      // "we did not see part of it" is not "we saw all of it", and the state
      // also stops the source being asked again in this request.
      if (block.partialFailure !== undefined) {
        this.logger.warn(
          `External search in ${state.provider.source} answered only in part: ` +
            describe(block.partialFailure),
        )
        state.status = classify(block.partialFailure)
      }

      block.results.forEach((result, position) => {
        // `rank` is absolute within the source's stream, so it stays comparable
        // across blocks; `block` is what actually keeps the order stable.
        state.entries.push({ result, block: index, rank: index * size + position })
      })
    } catch (error) {
      const status = classify(error)

      // `warn`, not `error`: an unreachable external source is an expected
      // state the user sees in the response, not a fault of this service.
      // Our own throttle says so explicitly, so nobody goes debugging the
      // provider for back-pressure we applied ourselves.
      this.logger.warn(
        `External search in ${state.provider.source} failed (${status}): ` + describe(error),
      )

      state.status = status
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
