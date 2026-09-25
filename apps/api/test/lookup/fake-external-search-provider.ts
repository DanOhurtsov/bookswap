import type { ExternalSearchResult } from '@bookswap/shared'
import type {
  ExternalSearchBlock,
  ExternalSearchBlockResult,
  ExternalSearchContext,
  ExternalSearchProvider,
} from '../../src/catalog/search/external/external-search-provider'

type Behaviour =
  | { kind: 'results'; results: ExternalSearchResult[] }
  | { kind: 'stream'; records: ExternalSearchResult[] }
  | { kind: 'error'; message: string }
  | { kind: 'hang' }

/** What the fake was asked for, so a test can assert on paging and on cost. */
export interface FakeBlockRequest {
  query: string
  index: number
  size: number
}

/**
 * A fake external search source — replaces real HTTP calls in e2e (§11: no
 * genuine request to Open Library or Google Books).
 *
 * It can do four things, and the last two matter as much as the first. It can
 * return results, **serve a stream of records block by block** (that is what
 * makes paging testable at all), fail, and **hang**. Without hanging there is no
 * way to test what per-source deadlines exist for — that a slow source does not
 * hold a fast one.
 */
export class FakeExternalSearchProvider implements ExternalSearchProvider {
  private behaviour: Behaviour = { kind: 'results', results: [] }

  /** Every block this source was asked for, in order. */
  readonly blocks: FakeBlockRequest[] = []

  constructor(readonly source: ExternalSearchProvider['source']) {}

  /** The same answer for every block — deliberately ignores paging. */
  returns(results: ExternalSearchResult[]): void {
    this.behaviour = { kind: 'results', results }
  }

  /**
   * A real stream: block `index` gets records `[index * size, (index+1) * size)`,
   * and `exhausted` is reported exactly, as Open Library's `numFound` allows.
   */
  streams(records: ExternalSearchResult[]): void {
    this.behaviour = { kind: 'stream', records }
  }

  fails(message = 'провайдер недоступний'): void {
    this.behaviour = { kind: 'error', message }
  }

  hangs(): void {
    this.behaviour = { kind: 'hang' }
  }

  clear(): void {
    this.behaviour = { kind: 'results', results: [] }
    this.blocks.length = 0
  }

  /** The queries seen, one entry per block asked for. */
  get queries(): string[] {
    return this.blocks.map((block) => block.query)
  }

  async search(
    query: string,
    block: ExternalSearchBlock,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchBlockResult> {
    this.blocks.push({ query, index: block.index, size: block.size })

    // A real provider takes a rate-limit slot before every call, and the e2e
    // suite asserts on `RATE_LIMITED`; a fake that skipped this would make the
    // limiter untestable through the endpoint.
    await context.acquire()

    if (this.behaviour.kind === 'error') throw new Error(this.behaviour.message)

    if (this.behaviour.kind === 'hang') {
      // Honours cancellation like a real HTTP provider would: otherwise a
      // dangling timer would keep the Jest process alive after the test ends.
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }

    if (this.behaviour.kind === 'stream') {
      const from = block.index * block.size
      const slice = this.behaviour.records.slice(from, from + block.size)

      return { results: slice, exhausted: from + slice.length >= this.behaviour.records.length }
    }

    // `exhausted` on the first block: a source that answers the same thing
    // whatever it is asked has nothing deeper to give, and saying otherwise
    // would make every test pay for a second block it does not want.
    return { results: block.index === 0 ? this.behaviour.results : [], exhausted: true }
  }
}
