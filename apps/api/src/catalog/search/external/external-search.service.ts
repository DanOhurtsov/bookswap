import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  SEARCH_MAX_PAGE,
  isValidIsbn13,
  splitSearchPage,
  type ExternalSearchMore,
  type ExternalSearchResponse,
  type ExternalSearchResult,
  type ExternalSearchSourceReport,
  type ExternalSearchSourceStatus,
  type SpellingSuggestion,
} from '@bookswap/shared'
import { runWithTimeout } from '../../lookup/lookup-timeout'
import { LocalMatches } from '../local-matches.service'
import {
  ExternalSearchCache,
  externalSearchCacheKey,
  type ExternalSearchMode,
} from './external-search.cache'
import {
  externalSearchBlockSize,
  externalSearchTimeoutMs,
  externalSuggestBlockSize,
  externalSuggestMinGapMs,
} from './external-search.config'
import {
  EXTERNAL_SEARCH_PROVIDERS,
  ExternalSearchProviderRateLimitedError,
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

/**
 * Maps external records (by `id`) to OUR edition they are already known as. Used by the add-book page
 * (`/me/library/add-search/external`); `/catalog/search/external` passes none.
 */
export type LocalMatcher = (
  records: readonly ExternalSearchResult[],
) => Promise<Map<string, string>>

/**
 * Marks matched records with `localEditionId` and collapses the ones that resolve to the same edition (the
 * first keeps its place). Deterministic for a given pool, so the pool stays prefix-stable across pages.
 */
async function markLocalEditions(
  pool: ExternalSearchResult[],
  matchLocal: LocalMatcher,
): Promise<ExternalSearchResult[]> {
  if (pool.length === 0) return pool

  const matches = await matchLocal(pool)
  const seen = new Set<string>()
  const result: ExternalSearchResult[] = []

  for (const record of pool) {
    const editionId = matches.get(record.id)

    if (editionId === undefined) {
      result.push(record)
      continue
    }

    if (seen.has(editionId)) continue

    seen.add(editionId)
    result.push({ ...record, localEditionId: editionId })
  }

  return result
}

/** What one source has contributed to this request so far. */
interface ProviderState {
  readonly provider: ExternalSearchProvider
  status: ExternalSearchSourceStatus
  /** The provider's stream ended — asking for a further block is pointless. */
  exhausted: boolean
  entries: RankedResult[]
  /** Titles and authors read BEFORE the relevance gate; only for the spelling correction. */
  spellingCandidates: Set<string>
}

/**
 * The correction for this request, decided from our catalog and everything the sources said together.
 * Reads only our database: the candidates are texts the providers already returned.
 */
async function spellingSuggestionOf(
  local: LocalMatches,
  query: string,
  states: readonly ProviderState[],
): Promise<{ spellingSuggestion: SpellingSuggestion } | undefined> {
  // The same book is usually named by both sources: each text goes to the decision once.
  const texts = new Set(states.flatMap((state) => [...state.spellingCandidates]))
  const text = await local.spellingSuggestion(query, [...texts])

  return text === undefined ? undefined : { spellingSuggestion: { forQuery: query, text } }
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
  async search(
    query: string,
    page: number,
    pageSize: number,
    options: { localTotal?: number; matchLocal?: LocalMatcher; spellingSuggestion?: boolean } = {},
  ): Promise<ExternalSearchResponse> {
    const matches = await this.local.rank(query, { authors: false })
    // `localTotal` — скільки рядків спільного списку належить нам. Для `/catalog/search` це кількість
    // творів; сторінка додавання рахує локальну половину у ВИДАННЯХ (`AddSearchService`) і передає
    // свою кількість, щоб обидві половини ділили сторінку за однією довжиною.
    const localTotal = options.localTotal ?? matches.works.length
    const { externalFrom, externalCount } = splitSearchPage({ page, pageSize, localTotal })

    // The page is made of our own rows alone AND more of them follow: nothing to
    // ask outside, and the next page is proved by the local half.
    if (externalCount === 0 && localTotal > page * pageSize) {
      return { results: [], sources: [], page, pageSize, more: 'UNKNOWN', complete: true }
    }

    const known = await this.local.isbnsOf(matches.works.map((row) => row.id))
    const blockSize = externalSearchBlockSize()
    const states: ProviderState[] = this.providers.map((provider) => ({
      provider,
      status: 'OK',
      exhausted: false,
      entries: [],
      spellingCandidates: new Set(),
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

      // Fast-add: records that are ALREADY our editions (by ISBN or a confirmed reference) are marked and
      // collapsed HERE, before the page is cut — never on the client, never after pagination.
      if (options.matchLocal !== undefined) pool = await markLocalEditions(pool, options.matchLocal)

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
      ...(options.spellingSuggestion === true
        ? await spellingSuggestionOf(this.local, query, states)
        : undefined),
    }
  }

  /**
   * The external half of an AUTO-SUGGEST — a fixed, capped mode, not a smaller page.
   *
   * The ceiling is held HERE, on the server, because a client's debounce is only a courtesy:
   *
   * - **Every registered source, once, in parallel** (today Open Library and Google Books; a
   *   source added to `EXTERNAL_SEARCH_PROVIDERS` — ISBNdb, should it ever get a title search —
   *   joins without touching this method). Each is asked for **one outbound request**
   *   (`maxQueries: 1`: Google's title reading, Open Library's single cross-field query) and
   *   each under its own deadline, so a slow or failing source costs the others nothing. A source
   *   that is down is reported in `sources`; the rest still answer.
   * - **One block per source, never read further.** No continuation, no second block, no paging:
   *   the answer is `complete` as it stands, and "more" is only a reason to offer the full search.
   * - **A free slot or nothing, per source.** `tryAcquire` refuses instead of queueing, so a
   *   refused suggestion is reported as `RATE_LIMITED` with no call made, and never delays a full
   *   search. The limiter is per source, so one source's cooldown does not mute the other.
   * - **Nothing at all for an ISBN or when our own catalog already fills the list.** Both are
   *   decided before any provider is touched.
   *
   * The cache entry is keyed in its own mode, so this one-query block can never stand in for a
   * full one. Errors, refusals and partial blocks are not cached (`ExternalSearchCache`), so a
   * failure is never remembered as "no such book".
   */
  async suggest(
    query: string,
    options: {
      limit: number
      localTotal: number
      matchLocal?: LocalMatcher
      spellingSuggestion?: boolean
    },
  ): Promise<ExternalSearchResponse> {
    const remaining = options.limit - options.localTotal
    const empty = (more: ExternalSearchMore): ExternalSearchResponse => ({
      results: [],
      sources: [],
      page: 1,
      pageSize: options.limit,
      more,
      complete: true,
    })

    // An exact ISBN is the lookup scenario's job; a text query built from it asks a nonsense question.
    if (isValidIsbn13(query) || this.providers.length === 0) return empty('NO')
    // Our own catalog already fills the list: nothing outside is asked.
    if (remaining <= 0) return empty('YES')

    const matches = await this.local.rank(query, { authors: false })
    const known = await this.local.isbnsOf(matches.works.map((row) => row.id))
    const states: ProviderState[] = this.providers.map((provider) => ({
      provider,
      status: 'OK',
      exhausted: false,
      entries: [],
      spellingCandidates: new Set(),
    }))

    await Promise.all(
      states.map(async (state) =>
        this.readBlock(state, query, 0, externalSuggestBlockSize(), {
          minGapMs: externalSuggestMinGapMs(),
        }),
      ),
    )

    let pool = mergeResults(
      query,
      states.flatMap((state) => state.entries),
    ).filter((result) => result.isbn13 === undefined || !known.has(result.isbn13))

    if (options.matchLocal !== undefined) pool = await markLocalEditions(pool, options.matchLocal)

    return {
      results: pool.slice(0, remaining),
      sources: states.map((state): ExternalSearchSourceReport => ({
        source: state.provider.source,
        status: state.status,
      })),
      page: 1,
      pageSize: options.limit,
      // Proof only: a record in hand beyond the list. "No more" needs every source to say it ended;
      // otherwise unknown — the full search may know more.
      more:
        pool.length > remaining
          ? 'YES'
          : states.every((state) => state.status === 'OK' && state.exhausted)
            ? 'NO'
            : 'UNKNOWN',
      complete: true,
      ...(options.spellingSuggestion === true
        ? await spellingSuggestionOf(this.local, query, states)
        : undefined),
    }
  }

  private coolDownOnRateLimit(
    source: ExternalSearchResult['sources'][number],
    error: unknown,
  ): void {
    if (error instanceof ExternalSearchProviderRateLimitedError) {
      this.limiter.penalize(source, error.retryAfterMs)
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
    suggest?: { minGapMs: number },
  ): Promise<void> {
    const mode: ExternalSearchMode = suggest === undefined ? 'FULL' : 'SUGGEST'
    const key = externalSearchCacheKey(state.provider.source, query, index, size, mode)

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
            //
            // A suggestion never queues for a slot: it takes a free one or is
            // refused, so it cannot delay a search somebody asked for.
            acquire: async () =>
              suggest === undefined
                ? this.limiter.acquire(state.provider.source, timeoutMs)
                : this.limiter.tryAcquire(state.provider.source, suggest.minGapMs),
          }

          // `maxQueries: 1` is what makes a suggestion ONE outbound request.
          return state.provider.search(
            query,
            suggest === undefined ? { index, size } : { index, size, maxQueries: 1 },
            context,
          )
        })

        if (outcome.kind === 'timeout') throw new ExternalSearchTimeoutError()

        // The provider's 429 puts the source on cooldown for everyone — here, in the call that
        // actually went out, so requests coalesced onto it do not each extend the pause.
        if (outcome.kind === 'error') {
          this.coolDownOnRateLimit(state.provider.source, outcome.error)
          throw outcome.error
        }

        if (outcome.value.partialFailure !== undefined) {
          this.coolDownOnRateLimit(state.provider.source, outcome.value.partialFailure)
        }

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

      for (const text of block.spellingCandidates ?? []) state.spellingCandidates.add(text)

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
  if (error instanceof ExternalSearchProviderRateLimitedError) return 'RATE_LIMITED'

  return 'ERROR'
}

function describe(error: unknown): string {
  if (error instanceof ExternalSearchTimeoutError) return 'deadline exceeded'

  return String(error)
}
