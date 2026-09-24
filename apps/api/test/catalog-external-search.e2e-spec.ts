import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_PREFIX,
  externalSearchResponseSchema,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
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
})
