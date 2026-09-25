import { Logger } from '@nestjs/common'
import type { ExternalSearchResult } from '@bookswap/shared'
import type { LocalMatches } from '../local-matches.service'
import { ExternalSearchCache } from './external-search.cache'
import {
  ExternalSearchProviderError,
  ExternalSearchTimeoutError,
  type ExternalSearchBlock,
  type ExternalSearchBlockResult,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { ExternalSearchService } from './external-search.service'
import { ProviderRateLimiter } from './provider-rate-limiter'

type Behaviour = (block: ExternalSearchBlock) => Promise<ExternalSearchBlockResult>

/** A fake instead of HTTP: no real outbound call (§11). */
class FakeProvider implements ExternalSearchProvider {
  /** Every block asked for, in order — paging and cost are asserted on this. */
  readonly blocks: ExternalSearchBlock[] = []

  constructor(
    readonly source: ExternalSearchProvider['source'],
    private behaviour: Behaviour,
  ) {}

  async search(
    query: string,
    block: ExternalSearchBlock,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchBlockResult> {
    // The slot is taken FIRST, exactly as a real provider does, and only then
    // is the call recorded. `calls` therefore counts calls that actually went
    // out — a request refused by our own back-pressure never reaches a provider.
    await context.acquire()
    this.blocks.push(block)
    this.calls.push(query)

    return this.behaviour(block)
  }

  readonly calls: string[] = []

  setBehaviour(behaviour: Behaviour): void {
    this.behaviour = behaviour
  }
}

/** The same answer whatever is asked — a source with nothing deeper to give. */
function answering(results: ExternalSearchResult[]): Behaviour {
  return (block) => Promise.resolve({ results: block.index === 0 ? results : [], exhausted: true })
}

/** A real stream: block `index` is records `[index * size, (index + 1) * size)`. */
function streaming(records: ExternalSearchResult[]): Behaviour {
  return (block) => {
    const from = block.index * block.size
    const slice = records.slice(from, from + block.size)

    return Promise.resolve({ results: slice, exhausted: from + slice.length >= records.length })
  }
}

function work(id: string, title: string): ExternalSearchResult {
  return { id, kind: 'WORK', sources: ['OPEN_LIBRARY'], title }
}

function edition(id: string, title: string): ExternalSearchResult {
  return { id, kind: 'EDITION', sources: ['GOOGLE_BOOKS'], title }
}

/**
 * `count` works with titles of EQUAL length.
 *
 * Equal length matters: `relevanceOf` scores partly by how much of the title the
 * query covers, so «Книжка 9» would outrank «Книжка 10» and the stream order
 * these tests are about would be reordered underneath them. With equal titles
 * relevance ties and the source's own position decides, which is exactly the
 * ordering rule under test.
 */
function series(count: number): ExternalSearchResult[] {
  return Array.from({ length: count }, (_, index) =>
    work(
      `OPEN_LIBRARY:OL${String(index).padStart(2, '0')}W`,
      `Книжка ${String(index).padStart(2, '0')}`,
    ),
  )
}

/**
 * A stand-in for our own catalog's side of the search: `total` local matches and
 * the ISBNs they hold. A cast, not a mock framework — the service uses exactly
 * these two members, and the real class needs a database.
 */
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

const titles = (response: { results: ExternalSearchResult[] }): string[] =>
  response.results.map((result) => result.title)

describe('ExternalSearchService', () => {
  const ORIGINAL_TIMEOUT = process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
  const ORIGINAL_BLOCK = process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE

  let openLibrary: FakeProvider
  let googleBooks: FakeProvider
  let service: ExternalSearchService

  beforeEach(() => {
    // The rate limiter must not slow the tests themselves — the interval is
    // lifted wherever it is not the subject.
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'

    openLibrary = new FakeProvider('OPEN_LIBRARY', answering([]))
    googleBooks = new FakeProvider('GOOGLE_BOOKS', answering([]))
    service = new ExternalSearchService(
      [openLibrary, googleBooks],
      new ExternalSearchCache(),
      new ProviderRateLimiter(),
      localOf(0),
    )

    // An expected source outage is logged as a warning — noise in test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = ORIGINAL_TIMEOUT

    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    if (ORIGINAL_BLOCK === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE
    else process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = ORIGINAL_BLOCK

    jest.restoreAllMocks()
  })

  it('опитує всі джерела й зводить їхню видачу в один список', async () => {
    openLibrary.setBehaviour(answering([work('OPEN_LIBRARY:OL1W', 'Тигролови')]))
    googleBooks.setBehaviour(answering([edition('GOOGLE_BOOKS:v1', 'Сад Гетсиманський')]))

    const response = await service.search('багряний', 1, 10)

    expect(response.results).toHaveLength(2)
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'OK' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
  })

  it('збій одного джерела не забирає результати іншого', async () => {
    openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    googleBooks.setBehaviour(answering([edition('GOOGLE_BOOKS:v1', 'Тигролови')]))

    const response = await service.search('тигролови', 1, 10)

    expect(response.results).toHaveLength(1)
    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'ERROR' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
  })

  it('падіння ВСІХ джерел — це все одно успішна відповідь зі статусами, а не виняток', async () => {
    openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
    googleBooks.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 429')))

    const response = await service.search('тигролови', 1, 10)

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
            resolve({ results: [work('OPEN_LIBRARY:OL1W', 'Запізнілий')], exhausted: true })
          }, 200)
        }),
    )
    googleBooks.setBehaviour(answering([edition('GOOGLE_BOOKS:v1', 'Вчасний')]))

    const response = await service.search('тигролови', 1, 10)

    expect(response.sources).toEqual([
      { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
      { source: 'GOOGLE_BOOKS', status: 'OK' },
    ])
    expect(titles(response)).toEqual(['Вчасний'])
  })

  it('повторний запит бере кеш і не турбує провайдера вдруге', async () => {
    openLibrary.setBehaviour(answering([work('OPEN_LIBRARY:OL1W', 'Тигролови')]))

    await service.search('тигролови', 1, 10)
    await service.search('  ТИГРОЛОВИ ', 1, 10)

    expect(openLibrary.calls).toHaveLength(1)
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
      localOf(0),
    )

    googleBooks.setBehaviour(answering([edition('GOOGLE_BOOKS:v1', 'Вчасний')]))

    const response = await throttled.search('тигролови', 1, 10)

    expect(response.sources).toContainEqual({ source: 'OPEN_LIBRARY', status: 'RATE_LIMITED' })
    // Our own back-pressure must not take the other source's results with it.
    expect(titles(response)).toEqual(['Вчасний'])
    expect(openLibrary.calls).toEqual([])
  })

  it('дублікат між джерелами показується однією карткою з двома джерелами', async () => {
    const shared = {
      kind: 'EDITION' as const,
      title: 'Тигролови',
      authors: ['Іван Багряний'],
      isbn13: '9786177585113',
    }

    openLibrary.setBehaviour(
      answering([{ ...shared, id: 'OPEN_LIBRARY:x', sources: ['OPEN_LIBRARY'] }]),
    )
    googleBooks.setBehaviour(
      answering([{ ...shared, id: 'GOOGLE_BOOKS:y', sources: ['GOOGLE_BOOKS'] }]),
    )

    const response = await service.search('тигролови', 1, 10)

    expect(response.results).toHaveLength(1)
    expect(response.results[0]?.sources).toEqual(['OPEN_LIBRARY', 'GOOGLE_BOOKS'])
  })

  describe('сторінки', () => {
    it('віддає рівно сторінку й наступну сторінку — далі по стрічці', async () => {
      openLibrary.setBehaviour(streaming(series(25)))

      const first = await service.search('книжка', 1, 10)
      const second = await service.search('книжка', 2, 10)

      expect(titles(first)).toEqual(
        series(25)
          .slice(0, 10)
          .map((record) => record.title),
      )
      expect(titles(second)).toEqual(
        series(25)
          .slice(10, 20)
          .map((record) => record.title),
      )
      expect(first.page).toBe(1)
      expect(second.page).toBe(2)
    })

    it('жодна книжка не повторюється на сусідніх сторінках', async () => {
      openLibrary.setBehaviour(streaming(series(25)))

      const first = await service.search('книжка', 1, 10)
      const second = await service.search('книжка', 2, 10)

      const overlap = first.results.filter((result) =>
        second.results.some((other) => other.id === result.id),
      )

      expect(overlap).toEqual([])
    })

    it('«є ще» — лише коли наступний запис уже в руках', async () => {
      openLibrary.setBehaviour(streaming(series(11)))

      await expect(service.search('книжка', 1, 10)).resolves.toMatchObject({ more: 'YES' })

      // Рівно сторінка й потік вичерпано: «далі немає» — це факт, а не здогад.
      openLibrary.setBehaviour(streaming(series(10)))
      await expect(service.search('інша', 1, 10)).resolves.toMatchObject({ more: 'NO' })
    })

    it('порядок читання джерела важить більше за релевантність МІЖ блоками', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '12'

      // Точний збіг лежить у ДРУГОМУ блоці стрічки. Він не має проскочити на
      // першу сторінку — інакше сторінка, яку людина вже бачила, переписалася б.
      openLibrary.setBehaviour(streaming([...series(12), work('OPEN_LIBRARY:exact', 'Книжка')]))

      const first = await service.search('книжка', 1, 10)
      const second = await service.search('книжка', 2, 10)

      expect(titles(first)).not.toContain('Книжка')
      expect(titles(second)).toContain('Книжка')
    })

    it('сторінка всередині вже прочитаного блоку не коштує жодного звернення', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '24'
      openLibrary.setBehaviour(streaming(series(24)))

      await service.search('книжка', 1, 10)
      const afterFirst = openLibrary.blocks.length

      await service.search('книжка', 2, 10)

      // Обидві сторінки живуть у блоці 0 — другий запит бере його з кешу.
      expect(openLibrary.blocks).toHaveLength(afterFirst)
      expect(openLibrary.blocks.every((block) => block.index === 0)).toBe(true)
    })

    it('за один запит довантажується щонайбільше один блок', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '4'
      openLibrary.setBehaviour(streaming(series(40)))

      // Сторінка 3 лежить у блоці 5 при блоці на 4 записи, але один запит
      // дочитує рівно один блок: дедлайн у джерела один на все.
      await service.search('книжка', 3, 10)

      expect(openLibrary.blocks.map((block) => block.index)).toEqual([0])
    })

    it('глибока сторінка досяжна повторними запитами, по блоку за раз', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '4'
      openLibrary.setBehaviour(streaming(series(40)))

      // Кожен наступний запит іде по вже прочитаних блоках безкоштовно й
      // дочитує один новий, тож глибина набирається натисканнями «Далі».
      for (let attempt = 0; attempt < 6; attempt += 1) await service.search('книжка', 2, 10)

      const response = await service.search('книжка', 2, 10)

      expect(titles(response)).toEqual(
        series(40)
          .slice(10, 20)
          .map((record) => record.title),
      )
    })

    it('мертве джерело не дає права на «Далі», живе — дає', async () => {
      openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
      googleBooks.setBehaviour(
        streaming(
          series(11).map((record, index) =>
            edition(`GOOGLE_BOOKS:v${String(index)}`, record.title),
          ),
        ),
      )

      const response = await service.search('книжка', 1, 10)

      expect(response.more).toBe('YES')
      expect(response.sources).toContainEqual({ source: 'OPEN_LIBRARY', status: 'ERROR' })

      // Саме́ «далі немає» від мертвого джерела не звучить: воно не відповіло
      // взагалі, і про його глибину ми нічого не знаємо.
      openLibrary.setBehaviour(() => Promise.reject(new ExternalSearchProviderError('HTTP 503')))
      googleBooks.setBehaviour(answering([]))

      await expect(service.search('порожньо', 1, 10)).resolves.toMatchObject({ more: 'NO' })
    })

    it('сторінка за межами стрічки порожня, а не повторює останню', async () => {
      openLibrary.setBehaviour(streaming(series(12)))

      const response = await service.search('книжка', 5, 10)

      expect(response.results).toEqual([])
      expect(response.more).toBe('NO')
      expect(response.complete).toBe(true)
      expect(response.page).toBe(5)
    })
  })

  describe('спільна сторінка: частка зовнішніх джерел', () => {
    function serviceWith(local: LocalMatches): ExternalSearchService {
      return new ExternalSearchService(
        [openLibrary, googleBooks],
        new ExternalSearchCache(),
        new ProviderRateLimiter(),
        local,
      )
    }

    it('pageSize — це розмір спільного списку: без локальних збігів усе зовнішнє', async () => {
      openLibrary.setBehaviour(streaming(series(60)))

      let response = await service.search('книжка', 1, 50)

      // Блок — 24 записи, а сторінка — 50: перший запит дає лише початок і чесно
      // каже, що довантаження триває.
      expect(response.complete).toBe(false)

      while (!response.complete) response = await service.search('книжка', 1, 50)

      expect(response.results).toHaveLength(50)
      expect(response.pageSize).toBe(50)
    })

    it('локальні збіги займають перші рядки сторінки, зовнішні добирають решту', async () => {
      openLibrary.setBehaviour(streaming(series(40)))
      const shared = serviceWith(localOf(3))

      const first = await shared.search('книжка', 1, 10)
      const second = await shared.search('книжка', 2, 10)

      // 3 + 7 на першій сторінці, потім рівно по 10, без повторів і дірок.
      expect(titles(first)).toEqual(
        series(40)
          .slice(0, 7)
          .map((record) => record.title),
      )
      expect(titles(second)).toEqual(
        series(40)
          .slice(7, 17)
          .map((record) => record.title),
      )
    })

    it('сторінка з самих локальних рядків не питає зовнішні джерела', async () => {
      const shared = serviceWith(localOf(25))

      const response = await shared.search('книжка', 1, 10)

      expect(response.results).toEqual([])
      expect(response.sources).toEqual([])
      expect(response.complete).toBe(true)
      expect(openLibrary.calls).toEqual([])
    })

    it('локальні закінчуються рівно на межі сторінки — пул пробується, щоб чесно сказати «далі»', async () => {
      openLibrary.setBehaviour(streaming(series(5)))
      const shared = serviceWith(localOf(10))

      const response = await shared.search('книжка', 1, 10)

      expect(response.results).toEqual([])
      expect(response.more).toBe('YES')
      expect(openLibrary.calls).toHaveLength(1)
    })

    it('зовнішній запис з ISBN, що вже є в наших збігах, відкидається ДО нарізання', async () => {
      const records: ExternalSearchResult[] = series(12).map((record, index) => ({
        ...edition(`GOOGLE_BOOKS:v${String(index)}`, record.title),
        isbn13: index === 0 ? '9786177585113' : undefined,
      }))

      googleBooks.setBehaviour(streaming(records))
      const shared = serviceWith(localOf(0, ['9786177585113']))

      const response = await shared.search('книжка', 1, 10)

      // Сторінка лишається ПОВНОЮ: відкинута картка не залишила дірки, а її місце
      // зайняв наступний запис.
      expect(response.results).toHaveLength(10)
      expect(titles(response)).not.toContain(records[0]?.title)
      expect(response.results.every((result) => result.isbn13 !== '9786177585113')).toBe(true)
    })
  })

  describe('регресії ревʼю', () => {
    it('дедуплікація ISBN діє ДО розрахунку more: відкинутий запис не дає хибного YES', async () => {
      // 10 своїх записів і 11-й, що вже є в нашому каталозі: після відсіву понад
      // сторінку нічого немає, а потік вичерпано.
      const records: ExternalSearchResult[] = series(11).map((record, index) => ({
        ...edition(`GOOGLE_BOOKS:v${String(index)}`, record.title),
        isbn13: index === 10 ? '9786177585113' : undefined,
      }))

      googleBooks.setBehaviour(streaming(records))
      const shared = new ExternalSearchService(
        [openLibrary, googleBooks],
        new ExternalSearchCache(),
        new ProviderRateLimiter(),
        localOf(0, ['9786177585113']),
      )

      const response = await shared.search('книжка', 1, 10)

      expect(response.results).toHaveLength(10)
      expect(response.more).toBe('NO')
    })

    it('№1: «далі» не зникає лише тому, що бюджет запиту — один блок', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '10'
      openLibrary.setBehaviour(streaming(series(30)))

      const response = await service.search('книжка', 1, 10)

      // Блок 0 дав рівно сторінку; доказу наступного запису ще немає, але потік
      // не вичерпано — це «невідомо», а не «немає».
      expect(response.results).toHaveLength(10)
      expect(response.more).toBe('UNKNOWN')
      expect(response.complete).toBe(true)
    })

    it('№2: глибока сторінка на холодному кеші — не хибно порожня, а «довантажується»', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '12'
      openLibrary.setBehaviour(streaming(series(60)))

      const cold = await service.search('книжка', 3, 10)

      expect(cold.results).toEqual([])
      expect(cold.complete).toBe(false)
      expect(cold.more).toBe('UNKNOWN')

      // Клієнт повторює той самий запит, доки `complete`; кожен читає ще блок.
      let response = cold
      let asks = 0

      while (!response.complete && asks < 10) {
        response = await service.search('книжка', 3, 10)
        asks += 1
      }

      expect(response.complete).toBe(true)
      expect(titles(response)).toEqual(
        series(60)
          .slice(20, 30)
          .map((record) => record.title),
      )
    })

    it('№2: цикл довантаження скінченний — вичерпане джерело дає complete', async () => {
      process.env.CATALOG_EXTERNAL_SEARCH_BLOCK_SIZE = '4'
      openLibrary.setBehaviour(streaming(series(6)))

      let response = await service.search('книжка', 3, 10)
      let asks = 0

      while (!response.complete && asks < 30) {
        response = await service.search('книжка', 3, 10)
        asks += 1
      }

      expect(response.complete).toBe(true)
      expect(response.results).toEqual([])
      expect(response.more).toBe('NO')
    })

    it('№5: часткова відповідь Google — не OK і не потрапляє в кеш як повна', async () => {
      const failure = new ExternalSearchProviderError('HTTP 500 в одному з підзапитів')
      const partial: Behaviour = () =>
        Promise.resolve({
          results: [edition('GOOGLE_BOOKS:v1', 'Тигролови')],
          exhausted: false,
          partialFailure: failure,
        })

      googleBooks.setBehaviour(partial)

      const first = await service.search('тигролови', 1, 10)

      expect(first.sources).toContainEqual({ source: 'GOOGLE_BOOKS', status: 'ERROR' })
      // Записи, що прийшли, не викидаються.
      expect(titles(first)).toEqual(['Тигролови'])

      googleBooks.setBehaviour(answering([edition('GOOGLE_BOOKS:v1', 'Тигролови')]))

      const second = await service.search('тигролови', 1, 10)

      // Неповний блок не зберігся: провайдера спитали ще раз і тепер він OK.
      expect(googleBooks.calls).toHaveLength(2)
      expect(second.sources).toContainEqual({ source: 'GOOGLE_BOOKS', status: 'OK' })
    })

    it('№5: пропущений через дедлайн підзапит теж дає TIMEOUT, а не OK', async () => {
      googleBooks.setBehaviour(() =>
        Promise.resolve({
          results: [edition('GOOGLE_BOOKS:v1', 'Тигролови')],
          exhausted: false,
          partialFailure: new ExternalSearchTimeoutError('deadline'),
        }),
      )

      const response = await service.search('тигролови', 1, 10)

      expect(response.sources).toContainEqual({ source: 'GOOGLE_BOOKS', status: 'TIMEOUT' })
    })
  })
})
