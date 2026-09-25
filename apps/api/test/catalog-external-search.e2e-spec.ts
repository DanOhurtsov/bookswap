import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  catalogSearchResponseSchema,
  externalSearchResponseSchema,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeExternalSearchProvider } from './lookup/fake-external-search-provider'

/**
 * `GET /catalog/search/external` — title search across external catalogs
 * (§6.3 extension; `docs/plan/stage-9-external-title-search.md`).
 *
 * Both providers are replaced by fakes through
 * `overrideProvider(EXTERNAL_SEARCH_PROVIDERS)` — no real HTTP (§11).
 */
describe('GET /catalog/search/external (e2e)', () => {
  let app: INestApplication<App>
  let cookie: string

  const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
  const googleBooks = new FakeExternalSearchProvider('GOOGLE_BOOKS')

  const ORIGINAL_TIMEOUT = process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS

  beforeAll(async () => {
    // Our own rate limiter must not slow e2e down — it has its own unit test.
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'

    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_SEARCH_PROVIDERS).useValue([openLibrary, googleBooks])
      },
    })

    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({
        email: uniqueEmail('external-search'),
        password: VALID_PASSWORD,
        displayName: 'Шукач',
      })
      .expect(201)

    cookie = sessionCookie(response.headers)
  })

  afterEach(() => {
    openLibrary.clear()
    googleBooks.clear()

    // The cache lives in the application process: without clearing it the next
    // test would get the previous one's results instead of its own.
    app.get(ExternalSearchCache).clear()
    app.get(ProviderRateLimiter).clear()

    if (ORIGINAL_TIMEOUT === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = ORIGINAL_TIMEOUT
  })

  afterAll(async () => {
    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  const work = (id: string, title: string): ExternalSearchResult => ({
    id: `OPEN_LIBRARY:${id}`,
    kind: 'WORK',
    sources: ['OPEN_LIBRARY'],
    title,
    authors: ['Іван Багряний'],
    workExternalId: id,
  })

  const edition = (id: string, title: string, isbn13?: string): ExternalSearchResult => ({
    id: `GOOGLE_BOOKS:${id}`,
    kind: 'EDITION',
    sources: ['GOOGLE_BOOKS'],
    title,
    authors: ['Іван Багряний'],
    ...(isbn13 === undefined ? {} : { isbn13 }),
  })

  it('без сесії — 401', async () => {
    await request(app.getHttpServer()).get(url('/catalog/search/external?q=тигролови')).expect(401)
  })

  it('закороткий запит — 400 і жодного звернення до провайдера', async () => {
    await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=т'))
      .set('Cookie', cookie)
      .expect(400)

    expect(openLibrary.queries).toEqual([])
    expect(googleBooks.queries).toEqual([])
  })

  it('зводить видачу обох джерел і звітує їхні статуси', async () => {
    openLibrary.returns([work('OL1W', 'Тигролови')])
    googleBooks.returns([edition('v1', 'Сад Гетсиманський', '9786177585113')])

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=багряний'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results).toHaveLength(2)
    expect(body.sources).toEqual(
      expect.arrayContaining([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'OK' },
      ]),
    )
  })

  it('частковий збій — 200 з результатами живого джерела й статусом ERROR для мертвого', async () => {
    openLibrary.fails('HTTP 503')
    googleBooks.returns([edition('v1', 'Тигролови', '9786177585113')])

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=тигролови'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results).toHaveLength(1)
    expect(body.sources).toEqual(
      expect.arrayContaining([
        { source: 'OPEN_LIBRARY', status: 'ERROR' },
        { source: 'GOOGLE_BOOKS', status: 'OK' },
      ]),
    )
  })

  it('падіння всіх джерел — усе одно 200, бо порожньо і невідомо — різні речі', async () => {
    openLibrary.fails()
    googleBooks.fails()

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=тигролови'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results).toEqual([])
    expect(body.sources.every((report) => report.status === 'ERROR')).toBe(true)
  })

  it('повільне джерело отримує TIMEOUT і не затримує швидке', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '50'
    openLibrary.hangs()
    googleBooks.returns([edition('v1', 'Вчасний', '9786177585113')])

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=тигролови'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results.map((result) => result.title)).toEqual(['Вчасний'])
    expect(body.sources).toEqual(
      expect.arrayContaining([{ source: 'OPEN_LIBRARY', status: 'TIMEOUT' }]),
    )
  })

  it('результат без ISBN повертається як є, а не відкидається', async () => {
    openLibrary.returns([work('OL1W', 'Самвидав')])
    googleBooks.returns([edition('v1', 'Брошура без ISBN')])

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=самвидав'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results).toHaveLength(2)
    expect(body.results.every((result) => result.isbn13 === undefined)).toBe(true)
  })

  it('однаковий ISBN із двох джерел — одна картка з обома джерелами', async () => {
    const isbn13 = '9786177585113'
    openLibrary.returns([{ ...edition('x', 'Тигролови', isbn13), sources: ['OPEN_LIBRARY'] }])
    googleBooks.returns([edition('y', 'Тигролови', isbn13)])

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=тигролови'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.sources).toEqual(
      expect.arrayContaining(['OPEN_LIBRARY', 'GOOGLE_BOOKS']),
    )
  })

  it('власне обмеження частоти звітується окремим статусом RATE_LIMITED', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '60000'
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '50'

    openLibrary.returns([work('OL1W', 'Тигролови')])
    googleBooks.returns([edition('v1', 'Тигролови', '9786177585113')])

    // The first pass consumes each source's only slot for the next minute.
    await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=перший'))
      .set('Cookie', cookie)
      .expect(200)

    const response = await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=другий'))
      .set('Cookie', cookie)
      .expect(200)

    const body = externalSearchResponseSchema.parse(response.body)

    // Our back-pressure must not be dressed up as a provider outage.
    expect(body.sources.every((report) => report.status === 'RATE_LIMITED')).toBe(true)

    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
  })

  it('повторний запит обслуговується з кешу, не турбуючи провайдера вдруге', async () => {
    openLibrary.returns([work('OL1W', 'Тигролови')])

    await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=тигролови'))
      .set('Cookie', cookie)
      .expect(200)

    await request(app.getHttpServer())
      .get(url('/catalog/search/external?q=ТИГРОЛОВИ'))
      .set('Cookie', cookie)
      .expect(200)

    expect(openLibrary.queries).toHaveLength(1)
  })

  describe('сторінки', () => {
    /** `count` творів з назвами однакової довжини — порядок вирішує стрічка. */
    const series = (count: number): ExternalSearchResult[] =>
      Array.from({ length: count }, (_, index) =>
        work(`OL${String(index).padStart(2, '0')}W`, `Книжка ${String(index).padStart(2, '0')}`),
      )

    // Унікальний запит: локальні збіги спільної бази не мають потрапити в
    // розрахунок сторінки, тож `L = 0` і вся сторінка — зовнішня.
    const QUERY = `тестовасерія${String(process.pid)}`

    async function page(query: string, number?: number, size?: number) {
      const suffix =
        (number === undefined ? '' : `&page=${String(number)}`) +
        (size === undefined ? '' : `&pageSize=${String(size)}`)
      const response = await request(app.getHttpServer())
        .get(url(`/catalog/search/external?q=${encodeURIComponent(query)}${suffix}`))
        .set('Cookie', cookie)
        .expect(200)

      return externalSearchResponseSchema.parse(response.body)
    }

    it('друга сторінка — наступні записи стрічки, а не ті самі', async () => {
      openLibrary.streams(series(25))

      const first = await page(QUERY, 1)
      const second = await page(QUERY, 2)

      expect(first.results).toHaveLength(10)
      expect(second.results).toHaveLength(10)
      expect(first.results.map((result) => result.id)).not.toEqual(
        second.results.map((result) => result.id),
      )

      const overlap = first.results.filter((result) =>
        second.results.some((other) => other.id === result.id),
      )

      expect(overlap).toEqual([])
    })

    it('адреса без page — це перша сторінка', async () => {
      openLibrary.streams(series(25))

      const implicit = await page(QUERY)
      const explicit = await page(QUERY, 1)

      expect(implicit.page).toBe(1)
      expect(implicit.results.map((result) => result.id)).toEqual(
        explicit.results.map((result) => result.id),
      )
    })

    it('«Далі» обіцяють лише за доказом наступного запису', async () => {
      openLibrary.streams(series(10))

      await expect(page(QUERY, 1)).resolves.toMatchObject({ more: 'NO', complete: true })

      app.get(ExternalSearchCache).clear()
      openLibrary.streams(series(11))

      await expect(page(QUERY, 1)).resolves.toMatchObject({ more: 'YES' })
    })

    it('pageSize=20 — двадцять карток, а не «10 + 10»; довантаження за complete', async () => {
      openLibrary.streams(series(45))

      let response = await page(QUERY, 1, 20)
      let asks = 1

      while (!response.complete && asks < 10) {
        response = await page(QUERY, 1, 20)
        asks += 1
      }

      expect(response.results).toHaveLength(20)
      expect(response.pageSize).toBe(20)
      expect(response.more).toBe('YES')
    })

    it('глибока сторінка на холодному кеші не хибно порожня: complete=false, потім записи', async () => {
      openLibrary.streams(series(60))

      let response = await page(QUERY, 4, 10)

      expect(response).toMatchObject({ results: [], complete: false, more: 'UNKNOWN' })

      let asks = 1

      while (!response.complete && asks < 10) {
        response = await page(QUERY, 4, 10)
        asks += 1
      }

      expect(response.results).toHaveLength(10)
      expect(response.results[0]?.title).toBe('Книжка 30')
    })

    it('недопустимий pageSize — 400 і жодного звернення до провайдера', async () => {
      await request(app.getHttpServer())
        .get(url(`/catalog/search/external?q=${QUERY}&pageSize=15`))
        .set('Cookie', cookie)
        .expect(400)

      expect(openLibrary.queries).toEqual([])
    })

    it('повернення на вже відкриту сторінку не витрачає нових звернень', async () => {
      openLibrary.streams(series(25))

      await page(QUERY, 1)
      await page(QUERY, 2)
      const spent = openLibrary.blocks.length

      // Назад на першу — і жодного нового звернення назовні.
      await page(QUERY, 1)

      expect(openLibrary.blocks).toHaveLength(spent)
    })

    it('частковий збій не заважає гортати живе джерело', async () => {
      googleBooks.fails('HTTP 503')
      openLibrary.streams(series(25))

      const second = await page(QUERY, 2)

      expect(second.results).toHaveLength(10)
      expect(second.sources).toEqual(
        expect.arrayContaining([{ source: 'GOOGLE_BOOKS', status: 'ERROR' }]),
      )
    })

    it('поламаний номер сторінки — 400 і жодного звернення до провайдера', async () => {
      const response = await request(app.getHttpServer())
        .get(url('/catalog/search/external?q=тигролови&page=0'))
        .set('Cookie', cookie)
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect(openLibrary.queries).toEqual([])
      expect(googleBooks.queries).toEqual([])
    })
  })

  describe('спільна сторінка з нашим каталогом', () => {
    async function createLocalWorks(token: string, count: number, isbns: string[] = []) {
      for (let index = 0; index < count; index += 1) {
        const created = await request(app.getHttpServer())
          .post(url('/works'))
          .set('Cookie', cookie)
          .send({
            title: `Змішана ${token} ${String(index)}`,
            origLang: 'uk',
            authors: [{ name: `Автор ${token}` }],
          })
          .expect(201)

        const isbn13 = isbns[index]

        if (isbn13 !== undefined) {
          await request(app.getHttpServer())
            .post(url(`/works/${(created.body as { work: { id: string } }).work.id}/editions`))
            .set('Cookie', cookie)
            .send({ publisher: 'КСД', year: 2019, isbn13 })
            .expect(201)
        }
      }
    }

    async function both(query: string, number: number, size: number) {
      const suffix = `&page=${String(number)}&pageSize=${String(size)}`
      const q = encodeURIComponent(query)
      const [local, external] = await Promise.all([
        request(app.getHttpServer())
          .get(url(`/catalog/search?q=${q}${suffix}`))
          .set('Cookie', cookie)
          .expect(200),
        request(app.getHttpServer())
          .get(url(`/catalog/search/external?q=${q}${suffix}`))
          .set('Cookie', cookie)
          .expect(200),
      ])

      return {
        local: catalogSearchResponseSchema.parse(local.body),
        external: externalSearchResponseSchema.parse(external.body),
      }
    }

    it('локальна й зовнішня частини разом дають рівно pageSize карток, без повторів між сторінками', async () => {
      const token = `змш${String(process.pid)}${String(Date.now() % 100_000)}`
      await createLocalWorks(token, 3)
      openLibrary.streams(
        Array.from({ length: 30 }, (_, index) =>
          work(
            `OL${String(index).padStart(2, '0')}W`,
            `Змішана ${token} зовн ${String(index).padStart(2, '0')}`,
          ),
        ),
      )

      const query = `Змішана ${token}`
      const first = await both(query, 1, 10)

      expect(first.local.total).toBeGreaterThanOrEqual(3)
      expect(first.local.results.length + first.external.results.length).toBe(10)

      // Друга сторінка починається з того місця пулу, де скінчилася перша.
      const second = await both(query, 2, 10)
      const ids = [...first.external.results, ...second.external.results].map((result) => result.id)

      expect(new Set(ids).size).toBe(ids.length)
    })

    it('зовнішній запис з ISBN нашого збігу відкидається на КОЖНІЙ сторінці', async () => {
      const token = `дед${String(process.pid)}${String(Date.now() % 100_000)}`
      const known = '9786177585113'
      // Свій ISBN: e2e ділять базу, тож чужий міг би вже існувати.
      const isbn = uniqueIsbn13('catalog-external-search')

      await createLocalWorks(token, 1, [isbn])
      openLibrary.returns([])
      googleBooks.streams([
        edition('dup', `Змішана ${token} дубль`, isbn),
        edition('other', `Змішана ${token} інша`, known),
      ])

      const result = await both(`Змішана ${token}`, 1, 10)

      expect(result.external.results.map((record) => record.id)).toEqual(['GOOGLE_BOOKS:other'])
    })

    it('сторінка з самих локальних рядків не питає зовнішні джерела', async () => {
      const token = `лок${String(process.pid)}${String(Date.now() % 100_000)}`
      await createLocalWorks(token, 12)

      const { external, local } = await both(`Змішана ${token}`, 1, 10)

      expect(local.results).toHaveLength(10)
      expect(external.results).toEqual([])
      expect(external.sources).toEqual([])
      expect(openLibrary.queries).toEqual([])
      expect(googleBooks.queries).toEqual([])
    })
  })
})
