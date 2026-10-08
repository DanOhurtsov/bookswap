import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  addSearchResponseSchema,
  apiErrorSchema,
  addSearchExternalResponseSchema,
  type AddSearchEditionItem,
  type AddSearchItem,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'
import { FakeExternalSearchProvider } from './lookup/fake-external-search-provider'

/**
 * Пошук для сторінки додавання (docs/plan/fast-book-add.md, §6, QA6/QA11): одиниця списку — видання,
 * розгортання робить сервер ДО нарізання сторінки, власні лічильники примірників — пакетно й без
 * чужих даних. Зовнішні джерела — фейки, жодного реального HTTP (§11).
 */
describe('GET /me/library/add-search (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
  const googleBooks = new FakeExternalSearchProvider('GOOGLE_BOOKS')
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS

  beforeAll(async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_SEARCH_PROVIDERS).useValue([openLibrary, googleBooks])
      },
    })
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    openLibrary.clear()
    googleBooks.clear()
    app.get(ExternalSearchCache).clear()
    app.get(ProviderRateLimiter).clear()
  })

  afterAll(async () => {
    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  /** Унікальне слово: трохи схожі назви інших e2e-файлів не потрапляють у вибірку. */
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

  async function search(account: Account, query: string, extra = '') {
    const response = await request(app.getHttpServer())
      .get(url(`/me/library/add-search?q=${encodeURIComponent(query)}${extra}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return addSearchResponseSchema.parse(response.body)
  }

  const editions = (items: AddSearchItem[]): AddSearchEditionItem[] =>
    items.filter((item): item is AddSearchEditionItem => item.kind === 'EDITION')

  describe('доступ і валідація', () => {
    it('без сесії — 401', async () => {
      const response = await request(app.getHttpServer())
        .get(url('/me/library/add-search?q=тигролови'))
        .expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })

    it.each([
      '/me/library/add-search?q=т',
      '/me/library/add-search?q=тигролови&page=0',
      '/me/library/add-search?q=тигролови&pageSize=7',
    ])('%s — 400', async (path) => {
      const account = await registerAccount(app, 'as-valid')

      await request(app.getHttpServer()).get(url(path)).set('Cookie', account.cookie).expect(400)
    })
  })

  describe('одиниця списку — видання', () => {
    it('розгортає твір у його видання (новіші — першими), а твір без видань лишає елементом WORK', async () => {
      const account = await registerAccount(app, 'as-expand')
      const word = token()
      const withEditions = await createWork(account, `${word} Із виданнями`)
      const without = await createWork(account, `${word} Без видань`)
      const older = await createEdition(account, withEditions, { publisher: 'Старе', year: 1999 })
      const newer = await createEdition(account, withEditions, { publisher: 'Нове', year: 2021 })
      const noYear = await createEdition(account, withEditions, { publisher: 'Без року' })

      const result = await search(account, word)
      const keys = result.items.map((item) => item.key)

      expect(result.total).toBe(4)
      expect(result.hasMore).toBe(false)
      expect(keys).toEqual(
        expect.arrayContaining([
          `edition:${older}`,
          `edition:${newer}`,
          `edition:${noYear}`,
          `work:${without}`,
        ]),
      )

      const own = editions(result.items).filter((item) => item.work.id === withEditions)

      // Найновіше — вище, видання без року — у кінці (`byEditionOrder`).
      expect(own.map((item) => item.edition.id)).toEqual([newer, older, noYear])
      expect(own[0]?.edition).toMatchObject({ publisher: 'Нове', year: 2021, format: null })
      expect(result.items.find((item) => item.kind === 'WORK')).toMatchObject({
        kind: 'WORK',
        work: { id: without },
      })
    })

    it('невідомі видання мають мову твору й лишаються конкретними картками', async () => {
      const account = await registerAccount(app, 'as-lang')
      const word = token()
      const workId = await createWork(account, word)

      await createEdition(account, workId, { publisher: 'КСД' })

      const [only] = editions((await search(account, word)).items)

      expect(only?.edition.lang).toBe('en')
      expect(only?.edition.translator).toBeNull()
    })

    it('сторінки не втрачають і не повторюють видання; total точний', async () => {
      const account = await registerAccount(app, 'as-pages')
      const word = token()
      const workId = await createWork(account, word)
      const ids: string[] = []

      for (let index = 0; index < 12; index += 1) {
        ids.push(
          await createEdition(account, workId, {
            publisher: `Видавець ${String(index)}`,
            year: 2000 + index,
          }),
        )
      }

      const first = await search(account, word)
      const second = await search(account, word, '&page=2')
      const wide = await search(account, word, '&pageSize=20')

      expect([first.items.length, second.items.length]).toEqual([10, 2])
      expect([first.total, second.total, wide.total]).toEqual([12, 12, 12])
      expect([first.hasMore, second.hasMore, wide.hasMore]).toEqual([true, false, false])

      const paged = [...first.items, ...second.items].map((item) => item.key)

      expect(new Set(paged).size).toBe(12)
      expect(paged).toEqual(wide.items.map((item) => item.key))
      expect([...paged].sort()).toEqual(ids.map((id) => `edition:${id}`).sort())
    })

    it('ISBN-запит: видання з точним ISBN — першим серед видань того самого твору', async () => {
      const account = await registerAccount(app, 'as-isbn')
      const workId = await createWork(account, token())
      const isbn = uniqueIsbn13('add-search')

      await createEdition(account, workId, { publisher: 'Новіше', year: 2024 })

      const exact = await createEdition(account, workId, {
        publisher: 'Точне',
        year: 1990,
        isbn13: isbn,
      })
      const result = await search(account, isbn)

      expect(result.items[0]).toMatchObject({ kind: 'EDITION', matchedOn: 'ISBN' })
      expect(result.items[0]?.key).toBe(`edition:${exact}`)
      expect(result.total).toBe(2)
    })
  })

  describe('стан «у моїй бібліотеці» (QA6, QA7)', () => {
    it('рахує лише власні примірники: активні й архівні окремо; чужі — не видно', async () => {
      const owner = await registerAccount(app, 'as-own')
      const stranger = await registerAccount(app, 'as-stranger')
      const word = token()
      const workId = await createWork(owner, word)
      const editionId = await createEdition(owner, workId, { publisher: 'КСД', year: 2019 })

      const addCopy = async (account: Account): Promise<string> => {
        const response = await request(app.getHttpServer())
          .post(url('/me/library'))
          .set('Cookie', account.cookie)
          .send({ editionId })
          .expect(201)

        return (response.body as { copy: { id: string } }).copy.id
      }

      await addCopy(owner)

      const toArchive = await addCopy(owner)

      await request(app.getHttpServer())
        .post(url(`/me/library/${toArchive}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)
      await addCopy(stranger)

      const mine = editions((await search(owner, word)).items)[0]
      const theirs = editions((await search(stranger, word)).items)[0]
      const nobody = await registerAccount(app, 'as-nobody')
      const none = editions((await search(nobody, word)).items)[0]

      expect(mine?.ownership).toEqual({ activeCount: 1, archivedCount: 1 })
      expect(theirs?.ownership).toEqual({ activeCount: 1, archivedCount: 0 })
      expect(none?.ownership).toEqual({ activeCount: 0, archivedCount: 0 })
    })

    it('інше видання того самого твору не вважається вже доданим', async () => {
      const account = await registerAccount(app, 'as-sibling')
      const word = token()
      const workId = await createWork(account, word)
      const owned = await createEdition(account, workId, { publisher: 'Моє', year: 2020 })
      const other = await createEdition(account, workId, { publisher: 'Інше', year: 2010 })

      await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', account.cookie)
        .send({ editionId: owned })
        .expect(201)

      const byId = new Map(
        editions((await search(account, word)).items).map((item) => [item.edition.id, item]),
      )

      expect(byId.get(owned)?.ownership.activeCount).toBe(1)
      expect(byId.get(other)?.ownership.activeCount).toBe(0)
    })

    it('відповідь не містить приватних полів власників', async () => {
      const owner = await registerAccount(app, 'as-private')
      const viewer = await registerAccount(app, 'as-viewer')
      const word = token()
      const workId = await createWork(owner, word)
      const editionId = await createEdition(owner, workId, { publisher: 'КСД' })

      await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', owner.cookie)
        .send({ editionId, note: 'ПРИВАТНА-НОТАТКА-ПОШУК', visibility: 'PRIVATE' })
        .expect(201)

      const response = await request(app.getHttpServer())
        .get(url(`/me/library/add-search?q=${word}`))
        .set('Cookie', viewer.cookie)
        .expect(200)
      const text = JSON.stringify(response.body)

      expect(text).not.toContain('ПРИВАТНА-НОТАТКА-ПОШУК')
      expect(text).not.toContain(owner.id)
    })
  })

  describe('зовнішня половина того самого списку', () => {
    const externalEdition = (id: string, isbn13?: string): ExternalSearchResult => ({
      id: `GOOGLE_BOOKS:${id}`,
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: `Зовнішня ${id}`,
      authors: ['Хтось'],
      ...(isbn13 === undefined ? {} : { isbn13 }),
    })

    async function external(account: Account, query: string, extra = '') {
      const response = await request(app.getHttpServer())
        .get(url(`/me/library/add-search/external?q=${encodeURIComponent(query)}${extra}`))
        .set('Cookie', account.cookie)
        .expect(200)

      return addSearchExternalResponseSchema.parse(response.body)
    }

    it('без сесії — 401', async () => {
      await request(app.getHttpServer())
        .get(url('/me/library/add-search/external?q=тигролови'))
        .expect(401)
    })

    it('ділить сторінку за довжиною локальної частини В ВИДАННЯХ, а не в творах', async () => {
      const account = await registerAccount(app, 'as-split')
      const word = token()
      const workId = await createWork(account, word)

      for (let index = 0; index < 12; index += 1) {
        await createEdition(account, workId, {
          publisher: `Видавець ${String(index)}`,
          year: 2000 + index,
        })
      }

      googleBooks.returns([externalEdition('g1'), externalEdition('g2')])

      // Сторінка 1 — 10 локальних видань, місця для зовнішніх немає й джерела не питаємо.
      const first = await external(account, word)

      expect(first.items).toEqual([])
      expect(googleBooks.blocks).toEqual([])

      // Сторінка 2: 2 останні локальні видання + 8 вільних місць для зовнішніх записів.
      const second = await external(account, word, '&page=2')

      expect(
        second.items.map((item) => (item.kind === 'EXTERNAL' ? item.result.id : item.key)),
      ).toEqual(['GOOGLE_BOOKS:g1', 'GOOGLE_BOOKS:g2'])
    })

    it('відкидає зовнішній запис, чий ISBN уже є серед локальних видань', async () => {
      const account = await registerAccount(app, 'as-dedupe')
      const word = token()
      const workId = await createWork(account, word)
      const isbn = uniqueIsbn13('add-search')

      await createEdition(account, workId, { publisher: 'КСД', isbn13: isbn })
      googleBooks.returns([externalEdition('dup', isbn), externalEdition('fresh')])

      const result = await external(account, word)

      expect(
        result.items.map((entry) => (entry.kind === 'EXTERNAL' ? entry.result.id : entry.key)),
      ).toEqual(['GOOGLE_BOOKS:fresh'])
    })

    it('запис, що вже є нашим виданням (за ISBN), але не знайдений локальним пошуком, підставляється локальною карткою зі станом володіння', async () => {
      const account = await registerAccount(app, 'as-subst')
      const word = token()
      const otherWork = await createWork(account, `${token()} Інша назва`)
      const number = uniqueIsbn13('add-search')
      const editionId = await createEdition(account, otherWork, {
        publisher: 'КСД',
        isbn13: number,
      })

      await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', account.cookie)
        .send({ editionId })
        .expect(201)

      // Локальний пошук за `word` цього твору не знаходить; зовнішнє джерело описує те саме видання.
      googleBooks.returns([externalEdition('same', number), externalEdition('fresh')])

      const result = await external(account, word)

      expect(result.items.map((item) => item.kind)).toEqual(['EDITION', 'EXTERNAL'])

      const [local] = result.items

      expect(local).toMatchObject({
        kind: 'EDITION',
        key: `edition:${editionId}`,
        ownership: { activeCount: 1, archivedCount: 0 },
      })
    })

    it('кілька записів, що зіставляються з одним виданням, згортаються ДО пагінації: сторінка лишається повною', async () => {
      const account = await registerAccount(app, 'as-collapse')
      const word = token()
      const workId = await createWork(account, `${token()} Інша`)
      const number = uniqueIsbn13('add-search')
      const editionId = await createEdition(account, workId, { isbn13: number })

      await prisma.editionExternalReference.create({
        data: { source: 'GOOGLE_BOOKS', externalId: 'ref-1', editionId },
      })
      googleBooks.returns([
        externalEdition('ref-1'),
        externalEdition('dup-by-isbn', number),
        externalEdition('fresh-1'),
        externalEdition('fresh-2'),
      ])

      const result = await external(account, word, '&pageSize=10')
      const keys = result.items.map((item) => item.key)

      expect(keys.filter((key) => key === `edition:${editionId}`)).toHaveLength(1)
      expect(keys).toEqual([
        `edition:${editionId}`,
        'external:GOOGLE_BOOKS:fresh-1',
        'external:GOOGLE_BOOKS:fresh-2',
      ])
    })

    it('ISBN і посилання вказують на різні видання: запис лишається зовнішнім (додавання дасть явний конфлікт)', async () => {
      const account = await registerAccount(app, 'as-ambiguous')
      const word = token()
      const workId = await createWork(account, `${token()} Інша`)
      const one = await createEdition(account, workId, { isbn13: uniqueIsbn13('add-search') })
      const number = uniqueIsbn13('add-search')
      const two = await createEdition(account, workId, { isbn13: number })

      await prisma.editionExternalReference.create({
        data: { source: 'GOOGLE_BOOKS', externalId: 'ambiguous', editionId: one },
      })
      googleBooks.returns([externalEdition('ambiguous', number)])

      const result = await external(account, word)

      expect(two).not.toBe(one)
      expect(result.items.map((item) => item.kind)).toEqual(['EXTERNAL'])
    })

    it('збій усіх джерел не ламає локальну половину', async () => {
      const account = await registerAccount(app, 'as-down')
      const word = token()
      const workId = await createWork(account, word)

      await createEdition(account, workId, { publisher: 'КСД' })
      openLibrary.fails('HTTP 503')
      googleBooks.fails('HTTP 503')

      const local = await search(account, word)
      const outside = await external(account, word)

      expect(local.total).toBe(1)
      expect(outside.items).toEqual([])
      expect(outside.sources.map((source) => source.status)).toEqual(['ERROR', 'ERROR'])
    })
  })
})
