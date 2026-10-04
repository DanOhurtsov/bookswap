import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  AUTO_SEARCH_RESULT_LIMIT,
  addSearchExternalResponseSchema,
  addSearchResponseSchema,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { createTestApp } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'
import { FakeExternalSearchProvider } from './lookup/fake-external-search-provider'

/**
 * Автопошук під час введення: `GET /me/library/add-search/suggest[/external]`. Режим фіксований і
 * обмежений НА СЕРВЕРІ — не лише debounce'ом у браузері. Зовнішні джерела — фейки (§11).
 */
describe('GET /me/library/add-search/suggest (e2e)', () => {
  let app: INestApplication<App>
  const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
  const googleBooks = new FakeExternalSearchProvider('GOOGLE_BOOKS')
  const touched = [
    'CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS',
    'CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS',
  ] as const
  const saved = new Map<string, string | undefined>()

  beforeAll(async () => {
    for (const key of touched) saved.set(key, process.env[key])

    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '1'
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_SEARCH_PROVIDERS).useValue([openLibrary, googleBooks])
      },
    })
  })

  afterEach(() => {
    openLibrary.clear()
    googleBooks.clear()
    app.get(ExternalSearchCache).clear()
    app.get(ProviderRateLimiter).clear()
  })

  afterAll(async () => {
    for (const key of touched) {
      const value = saved.get(key)

      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  const token = (): string => `Zqx${randomUUID().replaceAll('-', '').slice(0, 14)}`

  async function createWork(owner: Account, title: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', owner.cookie)
      .send({ title, origLang: 'en', authors: [{ name: `Автор ${title}` }] })
      .expect(201)

    return (response.body as { work: { id: string } }).work.id
  }

  async function createEdition(
    owner: Account,
    workId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(201)

    return (response.body as { edition: { id: string } }).edition.id
  }

  async function local(account: Account, query: string) {
    const response = await request(app.getHttpServer())
      .get(url(`/me/library/add-search/suggest?q=${encodeURIComponent(query)}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return addSearchResponseSchema.parse(response.body)
  }

  async function external(account: Account, query: string) {
    const response = await request(app.getHttpServer())
      .get(url(`/me/library/add-search/suggest/external?q=${encodeURIComponent(query)}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return addSearchExternalResponseSchema.parse(response.body)
  }

  const externalEdition = (id: string, isbn13?: string): ExternalSearchResult => ({
    id: `GOOGLE_BOOKS:${id}`,
    kind: 'EDITION',
    sources: ['GOOGLE_BOOKS'],
    title: `Зовнішня ${id}`,
    authors: ['Хтось'],
    ...(isbn13 === undefined ? {} : { isbn13 }),
  })

  describe('доступ і валідація', () => {
    it.each([
      '/me/library/add-search/suggest?q=тигролови',
      '/me/library/add-search/suggest/external?q=тигролови',
    ])('%s без сесії — 401', async (path) => {
      await request(app.getHttpServer()).get(url(path)).expect(401)
    })

    it.each([
      '/me/library/add-search/suggest?q=т',
      '/me/library/add-search/suggest/external?q=ти',
      '/me/library/add-search/suggest/external?q=%20%20т%20%20',
    ])('%s — 400 до будь-якого виходу назовні', async (path) => {
      const account = await registerAccount(app, 'sg-valid')

      await request(app.getHttpServer()).get(url(path)).set('Cookie', account.cookie).expect(400)
      expect(googleBooks.blocks).toHaveLength(0)
    })

    it('режим не послабити параметрами: сторінка й розмір — 400', async () => {
      const account = await registerAccount(app, 'sg-params')

      await request(app.getHttpServer())
        .get(url('/me/library/add-search/suggest/external?q=тигролови&pageSize=50'))
        .set('Cookie', account.cookie)
        .expect(400)
      await request(app.getHttpServer())
        .get(url('/me/library/add-search/suggest?q=тигролови&page=2'))
        .set('Cookie', account.cookie)
        .expect(400)
      expect(googleBooks.blocks).toHaveLength(0)
    })

    it('зайві пробіли — той самий запит: один виклик, одна кеш-клітинка', async () => {
      const account = await registerAccount(app, 'sg-spaces')

      googleBooks.returns([externalEdition('a')])
      await external(account, 'Тигролови  Багряний')
      await external(account, '  тигролови багряний ')

      expect(googleBooks.blocks).toHaveLength(1)
    })
  })

  describe('локальна половина', () => {
    it('віддає не більше ліміту й точні total та hasMore', async () => {
      const account = await registerAccount(app, 'sg-local')
      const word = token()
      const workId = await createWork(account, `${word} Багато видань`)

      for (let index = 0; index < AUTO_SEARCH_RESULT_LIMIT + 2; index += 1) {
        await createEdition(account, workId, {
          publisher: `Видавець ${String(index)}`,
          year: 2000 + index,
        })
      }

      const result = await local(account, word)

      expect(result.items).toHaveLength(AUTO_SEARCH_RESULT_LIMIT)
      expect(result.total).toBe(AUTO_SEARCH_RESULT_LIMIT + 2)
      expect(result.hasMore).toBe(true)
      expect(result.pageSize).toBe(AUTO_SEARCH_RESULT_LIMIT)
    })
  })

  describe('зовнішня половина: режим підказок обмежений на сервері', () => {
    it('кожне джерело — один блок і один запит; паралельно, без дочитування', async () => {
      const account = await registerAccount(app, 'sg-one')

      googleBooks.returns([externalEdition('a'), externalEdition('b')])

      const result = await external(account, token())

      expect(googleBooks.blocks).toHaveLength(1)
      expect(googleBooks.blocks[0]).toMatchObject({ index: 0, maxQueries: 1 })
      expect(openLibrary.blocks).toHaveLength(1)
      expect(openLibrary.blocks[0]).toMatchObject({ index: 0, maxQueries: 1 })
      expect(result.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'OK' },
      ])
      expect(result.items).toHaveLength(2)
      expect(result.complete).toBe(true)
    })

    it('валідний ISBN не запускає текстовий пошук', async () => {
      const account = await registerAccount(app, 'sg-isbn')

      const result = await external(account, '9783161484100')

      expect(googleBooks.blocks).toHaveLength(0)
      expect(openLibrary.blocks).toHaveLength(0)
      expect(result.items).toEqual([])
    })

    it('«1984» шукається як назва', async () => {
      const account = await registerAccount(app, 'sg-1984')

      await external(account, '1984')

      expect(googleBooks.blocks).toHaveLength(1)
    })

    it('збій джерела — 200 із статусом, без кешування й без повторів', async () => {
      const account = await registerAccount(app, 'sg-fail')
      const word = token()

      googleBooks.fails()

      const failed = await external(account, word)

      expect(failed.items).toEqual([])
      expect(failed.sources).toEqual([
        { source: 'OPEN_LIBRARY', status: 'OK' },
        { source: 'GOOGLE_BOOKS', status: 'ERROR' },
      ])
      expect(googleBooks.blocks).toHaveLength(1)

      // Збій не запам'ятався як «нічого немає»: наступна підказка питає знову.
      googleBooks.returns([externalEdition('late')])
      const recovered = await external(account, word)

      expect(recovered.items).toHaveLength(1)
      expect(googleBooks.blocks).toHaveLength(2)
    })

    it('ownership ізольований: спільний кеш зовнішніх метаданих не несе даних користувача', async () => {
      const owner = await registerAccount(app, 'sg-owner')
      const stranger = await registerAccount(app, 'sg-stranger')
      const word = token()
      const workId = await createWork(owner, `${token()} Інша назва`)
      const number = uniqueIsbn13('suggest')
      const editionId = await createEdition(owner, workId, { publisher: 'КСД', isbn13: number })

      await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', owner.cookie)
        .send({ editionId })
        .expect(201)

      googleBooks.returns([externalEdition('same', number), externalEdition('fresh')])

      const forOwner = await external(owner, word)
      const forStranger = await external(stranger, word)

      // Один виклик до провайдера на двох; ownership — лише в тому, кому належить.
      expect(googleBooks.blocks).toHaveLength(1)
      expect(forOwner.items[0]).toMatchObject({
        kind: 'EDITION',
        key: `edition:${editionId}`,
        ownership: { activeCount: 1, archivedCount: 0 },
      })
      expect(forStranger.items[0]).toMatchObject({
        kind: 'EDITION',
        key: `edition:${editionId}`,
        ownership: { activeCount: 0, archivedCount: 0 },
      })
      expect(JSON.stringify(forStranger)).not.toContain(owner.id)
    })

    it('підказка не підміняє повний пошук у кеші', async () => {
      const account = await registerAccount(app, 'sg-modes')
      const word = token()

      googleBooks.returns([externalEdition('a')])
      await external(account, word)
      await request(app.getHttpServer())
        .get(url(`/me/library/add-search/external?q=${encodeURIComponent(word)}`))
        .set('Cookie', account.cookie)
        .expect(200)

      // Підказка й повний пошук — різні виклики з різним планом: кеш їх не змішує.
      expect(googleBooks.blocks.map((block) => block.maxQueries)).toEqual([1, undefined])
      expect(openLibrary.blocks.map((block) => block.maxQueries)).toEqual([1, undefined])
    })
  })
})
