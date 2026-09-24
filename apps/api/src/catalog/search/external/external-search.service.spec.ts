import { Logger } from '@nestjs/common'
import type { ExternalSearchResult } from '@bookswap/shared'
import { ExternalSearchCache } from './external-search.cache'
import {
  ExternalSearchProviderError,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { ExternalSearchService } from './external-search.service'
import { ProviderRateLimiter } from './provider-rate-limiter'

/** A fake instead of HTTP: no real outbound call (§11). */
class FakeProvider implements ExternalSearchProvider {
  readonly calls: string[] = []

  constructor(
    readonly source: ExternalSearchProvider['source'],
    private behaviour: () => Promise<ExternalSearchResult[]>,
  ) {}

  async search(
    query: string,
    _limit: number,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchResult[]> {
    // The slot is taken FIRST, exactly as a real provider does, and only then
    // is the call recorded. `calls` therefore counts calls that actually went
    // out — a request refused by our own back-pressure never reaches a provider.
    await context.acquire()
    this.calls.push(query)

    return this.behaviour()
  }

  setBehaviour(behaviour: () => Promise<ExternalSearchResult[]>): void {
    this.behaviour = behaviour
  }
}

function work(id: string, title: string): ExternalSearchResult {
  return { id, kind: 'WORK', sources: ['OPEN_LIBRARY'], title }
}

function edition(id: string, title: string): ExternalSearchResult {
  return { id, kind: 'EDITION', sources: ['GOOGLE_BOOKS'], title }
}

describe('ExternalSearchService', () => {
  const ORIGINAL_TIMEOUT = process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS

  let openLibrary: FakeProvider
  let googleBooks: FakeProvider
  let service: ExternalSearchService

  beforeEach(() => {
    // The rate limiter must not slow the tests themselves — the interval is
    // lifted wherever it is not the subject.
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'

    openLibrary = new FakeProvider('OPEN_LIBRARY', () => Promise.resolve([]))
    googleBooks = new FakeProvider('GOOGLE_BOOKS', () => Promise.resolve([]))
    service = new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      new ProviderRateLimiter(),
    )

    // An expected source outage is logged as a warning — noise in test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = ORIGINAL_TIMEOUT

    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    jest.restoreAllMocks()
  })

  it('опитує всі джерела й зводить їхню видачу в один список', async () => {
    openLibrary.setBehaviour(() => Promise.resolve([work('OPEN_LIBRARY:OL1W', 'Тигролови')]))
    googleBooks.setBehaviour(() =>
      Promise.resolve([edition('GOOGLE_BOOKS:v1', 'Сад Гетсиманський')]),
    )

    const response = await service.search('багряний')

    expect(response.results).toHaveLength(2)
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
  })

  it('збій одного джерела не забирає результати іншого', async () => {
    openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    googleBooks.setBehaviour(() => Promise.resolve([edition('GOOGLE_BOOKS:v1', 'Тигролови')]))

    const response = await service.search('тигролови')

    expect(response.results).toHaveLength(1)
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'ERROR' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
  })

  it('падіння ВСІХ джерел — це все одно успішна відповідь зі статусами, а не виняток', async () => {
    openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    googleBooks.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 429')))

    const response = await service.search('тигролови')

    // An empty `results` with ERROR means "unknown", not "absent" — which is
    // exactly why statuses travel next to the list, and why this is not a 502.
    expect(response.results).toEqual([])
    expect(response.sources.every((report) => report.status === 'ERROR')).toBe(true)
  })

  it('повільне джерело позначається TIMEOUT і не тримає швидке', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '20'

    openLibrary.setBehaviour(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([work('OPEN_LIBRARY:OL1W', 'Запізнілий')])
          }, 200)
        }),
    )
    googleBooks.setBehaviour(() => Promise.resolve([edition('GOOGLE_BOOKS:v1', 'Вчасний')]))

    const response = await service.search('тигролови')

    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
    expect(response.results.map((result) => result.title)).toEqual(['Вчасний'])
  })

  it('повторний запит бере кеш і не турбує провайдера вдруге', async () => {
    openLibrary.setBehaviour(() => Promise.resolve([work('OPEN_LIBRARY:OL1W', 'Тигролови')]))

    await service.search('тигролови')
    await service.search('  ТИГРОЛОВИ ')

    expect(openLibrary.calls).toHaveLength(1)
  })

  it('обрізає зведений список до EXTERNAL_SEARCH_LIMIT', async () => {
    openLibrary.setBehaviour(() =>
      Promise.resolve(
        Array.from({ length: 20 }, (_, index) =>
          work(`OPEN_LIBRARY:OL${String(index)}W`, `Книжка ${String(index)}`),
        ),
      ),
    )

    const response = await service.search('книжка')

    expect(response.results).toHaveLength(12)
  })

  it('власне обмеження частоти звітується як RATE_LIMITED, а не як збій провайдера', async () => {
    // One slot per minute, so the second source in the same pass cannot get one.
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '60000'
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '50'

    const limiter = new ProviderRateLimiter()
    await limiter.acquire('OPEN_LIBRARY', 60_000)

    const throttled = new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      limiter,
    )

    googleBooks.setBehaviour(() => Promise.resolve([edition('GOOGLE_BOOKS:v1', 'Вчасний')]))

    const response = await throttled.search('тигролови')

    expect(response.sources).toContainEqual({ source: 'OPEN_LIBRARY', status: 'RATE_LIMITED' })
    // Our own back-pressure must not take the other source's results with it.
    expect(response.results.map((result) => result.title)).toEqual(['Вчасний'])
    expect(openLibrary.calls).toEqual([])
  })

  it('дублікат між джерелами показується однією карткою з двома джерелами', async () => {
    const shared = {
      kind: 'EDITION' as const,
      title: 'Тигролови',
      authors: ['Іван Багряний'],
      isbn13: '9786177585113',
    }

    openLibrary.setBehaviour(() =>
      Promise.resolve([{ ...shared, id: 'OPEN_LIBRARY:x', sources: ['OPEN_LIBRARY'] }]),
    )
    googleBooks.setBehaviour(() =>
      Promise.resolve([{ ...shared, id: 'GOOGLE_BOOKS:y', sources: ['GOOGLE_BOOKS'] }]),
    )

    const response = await service.search('тигролови')

    expect(response.results).toHaveLength(1)
    expect(response.results[0]?.sources).toEqual(['OPEN_LIBRARY', 'GOOGLE_BOOKS'])
  })
})
