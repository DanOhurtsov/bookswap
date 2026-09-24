import type { ExternalSearchResult } from '@bookswap/shared'
import type {
  ExternalSearchContext,
  ExternalSearchProvider,
} from '../../src/catalog/search/external/external-search-provider'

type Behaviour =
  | { kind: 'results'; results: ExternalSearchResult[] }
  | { kind: 'error'; message: string }
  | { kind: 'hang' }

/**
 * A fake external search source — replaces real HTTP calls in e2e (§11: no
 * genuine request to Open Library or Google Books).
 *
 * It can do three things, and the third matters as much as the first: return
 * results, fail, and **hang**. Without hanging there is no way to test what
 * per-source deadlines exist for — that a slow source does not hold a fast one.
 */
export class FakeExternalSearchProvider implements ExternalSearchProvider {
  private behaviour: Behaviour = { kind: 'results', results: [] }

  readonly queries: string[] = []

  constructor(readonly source: ExternalSearchProvider['source']) {}

  returns(results: ExternalSearchResult[]): void {
    this.behaviour = { kind: 'results', results }
  }

  fails(message = 'провайдер недоступний'): void {
    this.behaviour = { kind: 'error', message }
  }

  hangs(): void {
    this.behaviour = { kind: 'hang' }
  }

  clear(): void {
    this.behaviour = { kind: 'results', results: [] }
    this.queries.length = 0
  }

  async search(
    query: string,
    _limit: number,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchResult[]> {
    this.queries.push(query)

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

    return this.behaviour.results
  }
}
