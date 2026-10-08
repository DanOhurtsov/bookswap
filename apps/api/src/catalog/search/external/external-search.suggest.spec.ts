import { Logger } from '@nestjs/common'
import type { ExternalSearchResult } from '@bookswap/shared'
import type { LocalMatches } from '../local-matches.service'
import { ExternalSearchCache } from './external-search.cache'
import {
  ExternalSearchProviderError,
  ExternalSearchProviderRateLimitedError,
  type ExternalSearchBlock,
  type ExternalSearchBlockResult,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { ExternalSearchService } from './external-search.service'
import { ProviderRateLimiter } from './provider-rate-limiter'

type Behaviour = () => Promise<ExternalSearchBlockResult>

/** A fake instead of HTTP (§11): `blocks` holds only the calls that actually went out. */
class FakeProvider implements ExternalSearchProvider {
  readonly blocks: ExternalSearchBlock[] = []

  constructor(
    readonly source: ExternalSearchProvider['source'],
    private behaviour: Behaviour,
  ) {}

  async search(
    _query: string,
    block: ExternalSearchBlock,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchBlockResult> {
    // A refused slot never reaches the provider, exactly as with a real one.
    await context.acquire()
    this.blocks.push(block)

    return this.behaviour()
  }

  setBehaviour(behaviour: Behaviour): void {
    this.behaviour = behaviour
  }
}

const edition = (id: string, title: string, isbn13?: string): ExternalSearchResult => ({
  id: `GOOGLE_BOOKS:${id}`,
  kind: 'EDITION',
  sources: ['GOOGLE_BOOKS'],
  title,
  ...(isbn13 === undefined ? {} : { isbn13 }),
})

const answering =
  (results: ExternalSearchResult[]): Behaviour =>
  () =>
    Promise.resolve({ results, exhausted: true })

/** Equal-length titles: relevance ties, so the provider's own order decides. */
const many = (count: number): ExternalSearchResult[] =>
  Array.from({ length: count }, (_, index) =>
    edition(`v${String(index)}`, `Кобзар ${String(index).padStart(2, '0')}`),
  )

function localOf(total: number, isbns: string[] = []): LocalMatches {
  return {
    rank: () =>
      Promise.resolve({
        works: Array.from({ length: total }, (_, index) => ({
          id: `w${String(index)}`,
          titleScore: 1,
          authorScore: 0,
        })),
        authors: [],
        byIsbn: false,
      }),
    isbnsOf: () => Promise.resolve(new Set(isbns)),
  } as unknown as LocalMatches
}

const LIMIT = 8

describe('ExternalSearchService.suggest — обмежений режим автопідказок', () => {
  const touched = [
    'CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS',
    'CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS',
    'CATALOG_EXTERNAL_RATE_LIMIT_COOLDOWN_MS',
    'CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS',
  ] as const
  const saved = new Map<string, string | undefined>()

  let openLibrary: FakeProvider
  let googleBooks: FakeProvider

  function build(local: LocalMatches = localOf(0)): ExternalSearchService {
    return new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      new ProviderRateLimiter(),
      local,
    )
  }

  beforeEach(() => {
    for (const key of touched) saved.set(key, process.env[key])

    // Neither the interval nor the suggestion gap is the subject unless a test says so.
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '1'

    openLibrary = new FakeProvider('OPEN_LIBRARY', answering([]))
    googleBooks = new FakeProvider('GOOGLE_BOOKS', answering(many(3)))

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const key of touched) {
      const value = saved.get(key)

      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    jest.restoreAllMocks()
  })

  it('кожне джерело — один блок і один запит, паралельно; дочитування немає', async () => {
    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(googleBooks.blocks).toEqual([{ index: 0, size: 16, maxQueries: 1 }])
    expect(openLibrary.blocks).toEqual([{ index: 0, size: 16, maxQueries: 1 }])
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
    expect(response.results).toHaveLength(3)
    expect(response.complete).toBe(true)
  })

  it('навіть коли відповідь коротка, другий блок не читається', async () => {
    googleBooks.setBehaviour(() => Promise.resolve({ results: many(2), exhausted: false }))

    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(googleBooks.blocks).toHaveLength(1)
    expect(response.results).toHaveLength(2)
    expect(response.more).toBe('UNKNOWN')
    expect(response.complete).toBe(true)
  })

  it('валідний ISBN не запускає текстовий пошук: жодного виклику', async () => {
    const response = await build().suggest('9783161484100', { limit: LIMIT, localTotal: 0 })

    expect(googleBooks.blocks).toHaveLength(0)
    expect(openLibrary.blocks).toHaveLength(0)
    expect(response.results).toEqual([])
    expect(response.sources).toEqual([])
  })

  it('«1984» — це назва, а не ISBN: запит іде', async () => {
    await build().suggest('1984', { limit: LIMIT, localTotal: 0 })

    expect(googleBooks.blocks).toHaveLength(1)
  })

  it('наш каталог уже заповнив список: назовні не питається нічого', async () => {
    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: LIMIT })

    expect(googleBooks.blocks).toHaveLength(0)
    expect(openLibrary.blocks).toHaveLength(0)
    expect(response.results).toEqual([])
    expect(response.more).toBe('YES')
  })

  it('зовнішня половина бере лише те, що лишилося до ліміту', async () => {
    googleBooks.setBehaviour(answering(many(12)))

    const response = await build(localOf(5)).suggest('кобзар', { limit: LIMIT, localTotal: 5 })

    expect(response.results).toHaveLength(3)
    expect(response.more).toBe('YES')
  })

  it('більше ліміту не віддається ніколи', async () => {
    googleBooks.setBehaviour(answering(many(16)))

    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(response.results).toHaveLength(LIMIT)
    expect(response.more).toBe('YES')
  })

  it('запис, чий ISBN уже є в нашому каталозі, не дублюється зовнішнім', async () => {
    googleBooks.setBehaviour(
      answering([
        edition('v1', 'Кобзар 01', '9783161484100'),
        edition('v2', 'Кобзар 02', '9780306406157'),
      ]),
    )

    const response = await build(localOf(1, ['9783161484100'])).suggest('кобзар', {
      limit: LIMIT,
      localTotal: 1,
    })

    expect(response.results.map((record) => record.isbn13)).toEqual(['9780306406157'])
  })

  it('однакові одночасні підказки ділять один виклик до провайдера', async () => {
    let release: (() => void) | undefined

    googleBooks.setBehaviour(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ results: many(2), exhausted: true })
          }
        }),
    )

    const service = build()
    // Перший клієнт «пішов» і відповіді не чекає — запит від цього не скасовується.
    void service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
    const second = service.suggest('  Кобзар ', { limit: LIMIT, localTotal: 0 })

    await new Promise((resolve) => setImmediate(resolve))
    release?.()

    expect((await second).results).toHaveLength(2)
    expect(googleBooks.blocks).toHaveLength(1)
  })

  it('кеш підказок і повного пошуку не змішується', async () => {
    const service = build()

    await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
    await service.search('кобзар', 1, 10)

    // Повний пошук не взяв скорочену відповідь підказки: він прочитав власний блок.
    expect(googleBooks.blocks.some((block) => block.maxQueries === undefined)).toBe(true)
    expect(googleBooks.blocks).toHaveLength(2)

    // А повторна підказка вже береться з кешу підказок.
    await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
    expect(googleBooks.blocks).toHaveLength(2)
  })

  it('підтверджена порожня відповідь кешується, помилка — ні', async () => {
    const service = build()

    googleBooks.setBehaviour(answering([]))
    await service.suggest('порожньо', { limit: LIMIT, localTotal: 0 })
    await service.suggest('порожньо', { limit: LIMIT, localTotal: 0 })
    expect(googleBooks.blocks).toHaveLength(1)

    googleBooks.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const failed = await service.suggest('збій', { limit: LIMIT, localTotal: 0 })

    expect(failed.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'ERROR' },
    ])
    expect(failed.results).toEqual([])

    // Збій не запам'ятався як «нічого немає»: наступна підказка питає знову.
    googleBooks.setBehaviour(answering(many(1)))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const recovered = await service.suggest('збій', { limit: LIMIT, localTotal: 0 })

    expect(recovered.results).toHaveLength(1)
  })

  it('таймаут — один виклик і жодного циклу повторів', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '20'
    googleBooks.setBehaviour(() => new Promise(() => undefined))

    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'TIMEOUT' },
    ])
    expect(googleBooks.blocks).toHaveLength(1)
  })

  it('збій одного джерела не забирає відповідь іншого', async () => {
    openLibrary.setBehaviour(
      answering([{ ...edition('ol1', 'Кобзар 00'), sources: ['OPEN_LIBRARY'] }]),
    )
    googleBooks.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))

    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(response.results).toHaveLength(1)
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'ERROR' },
    ])
    expect(response.more).toBe('UNKNOWN')

    // І навпаки: Open Library недоступна, Google відповів.
    openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    googleBooks.setBehaviour(answering(many(2)))
    await new Promise((resolve) => setTimeout(resolve, 5))

    const reverse = await build().suggest('кобзарі', { limit: LIMIT, localTotal: 0 })

    expect(reverse.results).toHaveLength(2)
    expect(reverse.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'ERROR' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
  })

  it('один і той самий запис із двох джерел — одна картка зі списком джерел', async () => {
    const isbn = '9780306406157'

    openLibrary.setBehaviour(
      answering([{ ...edition('ol1', 'Кобзар 00', isbn), sources: ['OPEN_LIBRARY'] }]),
    )
    googleBooks.setBehaviour(answering([edition('g1', 'Кобзар 00', isbn)]))

    const response = await build().suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(response.results).toHaveLength(1)
    expect(response.results[0]?.sources).toEqual(
      expect.arrayContaining(['OPEN_LIBRARY', 'GOOGLE_BOOKS']),
    )
  })

  it('кеш підказок — окремо для кожного джерела: повторна підказка не питає нікого', async () => {
    const service = build()

    await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
    await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })

    expect(googleBooks.blocks).toHaveLength(1)
    expect(openLibrary.blocks).toHaveLength(1)
  })

  describe('429 і межі виходу', () => {
    it('429 з Retry-After → RATE_LIMITED, охолодження, і ні кеш, ні повтор', async () => {
      const now = jest.spyOn(Date, 'now')
      let clock = 1_000_000

      now.mockImplementation(() => clock)
      googleBooks.setBehaviour(() =>
        Promise.reject(new ExternalSearchProviderRateLimitedError('HTTP 429', 30_000)),
      )

      const service = build()
      const first = await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })

      expect(first.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' },
      ])
      expect(googleBooks.blocks).toHaveLength(1)

      // Усередині паузи інша підказка навіть не доходить до провайдера, і ПОВНИЙ пошук теж.
      clock += 10_000
      const during = await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })

      // Охолоджене лише те джерело, що відповіло 429: Open Library питається далі.
      expect(during.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' },
      ])
      expect(googleBooks.blocks).toHaveLength(1)
      expect(openLibrary.blocks).toHaveLength(2)

      const full = await service.search('кобзарі', 1, 10)

      expect(full.sources.find((source) => source.source === 'GOOGLE_BOOKS')?.status).toBe(
        'RATE_LIMITED',
      )
      expect(googleBooks.blocks).toHaveLength(1)

      // Після паузи джерело знову питається — і відповідь 429 не лишилась у кеші.
      clock += 25_000
      googleBooks.setBehaviour(answering(many(1)))
      const after = await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })

      expect(after.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'OK' },
      ])
      expect(after.results).toHaveLength(1)
    })

    it('без Retry-After пауза береться з налаштування, а не вигадується', async () => {
      process.env.CATALOG_EXTERNAL_RATE_LIMIT_COOLDOWN_MS = '5000'

      const now = jest.spyOn(Date, 'now')
      let clock = 2_000_000

      now.mockImplementation(() => clock)
      googleBooks.setBehaviour(() =>
        Promise.reject(new ExternalSearchProviderRateLimitedError('HTTP 429')),
      )

      const service = build()

      await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
      clock += 4_000
      await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })
      expect(googleBooks.blocks).toHaveLength(1)

      clock += 2_000
      googleBooks.setBehaviour(answering(many(1)))
      await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })
      expect(googleBooks.blocks).toHaveLength(2)
    })

    it('підказка не стає в чергу: слот зайнято — відмова без виклику назовні', async () => {
      process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '60000'

      const service = build()

      await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
      const refused = await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })

      expect(refused.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'RATE_LIMITED' },
        { source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' },
      ])
      expect(refused.results).toEqual([])
      expect(googleBooks.blocks).toHaveLength(1)
      expect(openLibrary.blocks).toHaveLength(1)
    })

    it('відмова не кешується: пізніше та сама підказка питає знову', async () => {
      process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '40'

      const service = build()

      await service.suggest('кобзар', { limit: LIMIT, localTotal: 0 })
      await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })
      expect(googleBooks.blocks).toHaveLength(1)

      await new Promise((resolve) => setTimeout(resolve, 60))
      await service.suggest('кобзарі', { limit: LIMIT, localTotal: 0 })
      expect(googleBooks.blocks).toHaveLength(2)
    })
  })
})

describe('ExternalSearchService — кандидати для підказки виправлення', () => {
  const FIXED = 'Гаррі Поттер'
  let openLibrary: FakeProvider
  let googleBooks: FakeProvider
  let spelling: jest.Mock
  let service: ExternalSearchService

  /** Відповідь, у якій правильна назва є лише кандидатом: ворота її не пропустили. */
  const rejectedFixed =
    (results: ExternalSearchResult[]): Behaviour =>
    () =>
      Promise.resolve({
        results,
        exhausted: true,
        spellingCandidates: [FIXED, 'Джоан Роулінг'],
      })

  beforeEach(() => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '1'

    spelling = jest.fn().mockResolvedValue(FIXED)
    openLibrary = new FakeProvider('OPEN_LIBRARY', rejectedFixed([]))
    googleBooks = new FakeProvider('GOOGLE_BOOKS', rejectedFixed([]))
    service = new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      new ProviderRateLimiter(),
      { ...localOf(0), spellingSuggestion: spelling } as unknown as LocalMatches,
    )
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    delete process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS
    jest.restoreAllMocks()
  })

  it('автопідказки: кандидати обох джерел (без повторів) йдуть у рішення, підказка прив’язана до запиту', async () => {
    const response = await service.suggest('гарі потер', {
      limit: 8,
      localTotal: 0,
      spellingSuggestion: true,
    })

    expect(spelling).toHaveBeenCalledTimes(1)
    // Обидва джерела назвали ті самі тексти — до рішення вони йдуть по одному разу.
    expect(spelling).toHaveBeenCalledWith('гарі потер', [FIXED, 'Джоан Роулінг'])
    expect(response.spellingSuggestion).toEqual({ forQuery: 'гарі потер', text: FIXED })
    // Кандидат не став карткою: звичайні результати — як були.
    expect(response.results).toEqual([])
  })

  it('повний пошук: те саме, і кандидати не потрапляють до пулу сторінок', async () => {
    const response = await service.search('гарі потер', 1, 10, { spellingSuggestion: true })

    expect(spelling).toHaveBeenCalledWith('гарі потер', [FIXED, 'Джоан Роулінг'])
    expect(response.spellingSuggestion).toEqual({ forQuery: 'гарі потер', text: FIXED })
    expect(response.results).toEqual([])
  })

  it('кількість звернень до джерел та сама, що й без підказки', async () => {
    await service.suggest('гарі потер', { limit: 8, localTotal: 0, spellingSuggestion: true })
    const withSpelling = [openLibrary.blocks.length, googleBooks.blocks.length]

    openLibrary.blocks.length = 0
    googleBooks.blocks.length = 0
    const plain = new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      new ProviderRateLimiter(),
      localOf(0),
    )

    await plain.suggest('гарі потер', { limit: 8, localTotal: 0 })

    expect(withSpelling).toEqual([1, 1])
    expect([openLibrary.blocks.length, googleBooks.blocks.length]).toEqual(withSpelling)
  })

  it('без опції підказка не рахується: ні виклику рішення, ні поля', async () => {
    const response = await service.search('гарі потер', 1, 10)

    expect(spelling).not.toHaveBeenCalled()
    expect(response).not.toHaveProperty('spellingSuggestion')
  })

  it('кеш зберігає кандидатів: повторний запит нічого не питає в джерел, а підказка та сама', async () => {
    await service.search('гарі потер', 1, 10, { spellingSuggestion: true })

    const asked = [openLibrary.blocks.length, googleBooks.blocks.length]
    const again = await service.search('гарі потер', 1, 10, { spellingSuggestion: true })

    expect([openLibrary.blocks.length, googleBooks.blocks.length]).toEqual(asked)
    expect(spelling).toHaveBeenLastCalledWith('гарі потер', [FIXED, 'Джоан Роулінг'])
    expect(again.spellingSuggestion?.text).toBe(FIXED)
  })

  it('ISBN: джерела не питаються й рішення не викликається', async () => {
    const response = await service.suggest('9783161484100', {
      limit: 8,
      localTotal: 0,
      spellingSuggestion: true,
    })

    expect(spelling).not.toHaveBeenCalled()
    expect(response.sources).toEqual([])
    expect(response).not.toHaveProperty('spellingSuggestion')
  })

  it('рішення відмовило — поля немає', async () => {
    spelling.mockResolvedValue(undefined)

    const response = await service.suggest('кобзар', {
      limit: 8,
      localTotal: 0,
      spellingSuggestion: true,
    })

    expect(response).not.toHaveProperty('spellingSuggestion')
  })
})
