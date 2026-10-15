import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  addSearchExternalResponseSchema,
  addSearchResponseSchema,
  apiErrorSchema,
  libraryResponseSchema,
  quickAddResponseSchema,
  type BookLookupResult,
  type ExternalSearchResult,
  type QuickAddResponse,
} from '@bookswap/shared'
import { EXTERNAL_VOLUME_PROVIDER } from '../src/catalog/lookup/google-books-volume-provider'
import type { GoogleVolumeRecord } from '../src/catalog/lookup/google-books-lookup-provider'
import { MergeCliModule } from '../src/cli/merge-cli.module'
import { MergeService } from '../src/catalog/merge/merge.service'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { EXTERNAL_WORK_PROVIDER } from '../src/catalog/search/external/open-library-work-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { CopyWriter } from '../src/library/copy-writer'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { beginRequest } from './concurrency.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'
import { FakeExternalSearchProvider } from './lookup/fake-external-search-provider'
import { FakeVolumeProvider } from './lookup/fake-volume-provider'
import { FakeWorkProvider } from './lookup/fake-work-provider'

/**
 * BS-114 (docs/plan/fast-book-add.md, §13): a WORK record without a specific edition is added by one explicit
 * press — `Work → Edition → Copy`, the record's cover, title, authors and first publication year, a confirmed
 * work reference; unknown edition data stays unknown. «Уточнити дані» keeps the cover and the identity.
 * Sources are fakes — no real HTTP (§11).
 */
describe('POST /me/library/quick-add — запис твору без видання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const works = new FakeWorkProvider()
  const volumes = new FakeVolumeProvider()
  const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
  const ORIGINAL_TIMEOUT = process.env.CATALOG_LOOKUP_TIMEOUT_MS
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
  let sequence = 0

  beforeAll(async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_WORK_PROVIDER).useValue(works)
        builder.overrideProvider(EXTERNAL_VOLUME_PROVIDER).useValue(volumes)
        builder.overrideProvider(EXTERNAL_SEARCH_PROVIDERS).useValue([openLibrary])
      },
    })
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    works.clear()
    volumes.clear()
    openLibrary.clear()
    app.get(ExternalSearchCache).clear()
    app.get(ProviderRateLimiter).clear()

    if (ORIGINAL_TIMEOUT === undefined) delete process.env.CATALOG_LOOKUP_TIMEOUT_MS
    else process.env.CATALOG_LOOKUP_TIMEOUT_MS = ORIGINAL_TIMEOUT
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

  const token = (): string => `Wrk${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const COVER = 'https://covers.openlibrary.org/b/id/6498519-M.jpg'

  /** A fresh `OL…W` per test: the e2e files share one database. */
  function workId(): string {
    sequence += 1

    return `OL${String(Date.now())}${String(sequence)}W`
  }

  function record(id: string, over: Partial<ExternalSearchResult> = {}): ExternalSearchResult {
    return {
      id: `OPEN_LIBRARY:${id}`,
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: token(),
      externalId: id,
      workExternalId: id,
      ...over,
    }
  }

  const target = (id: string, extra: Record<string, unknown> = {}) => ({
    kind: 'EXTERNAL_WORK',
    source: 'OPEN_LIBRARY',
    externalId: id,
    ...extra,
  })

  const post = (account: Account, body: unknown, server: INestApplication<App> = app) =>
    request(server.getHttpServer())
      .post(url('/me/library/quick-add'))
      .set('Cookie', account.cookie)
      .send(body as object)

  async function added(account: Account, body: unknown): Promise<QuickAddResponse> {
    const response = await post(account, { operationId: randomUUID(), target: body }).expect(201)

    return quickAddResponseSchema.parse(response.body)
  }

  const referenceOf = (id: string) =>
    prisma.workExternalReference.findUnique({
      where: { source_externalId: { source: 'OPEN_LIBRARY', externalId: id } },
    })

  describe('пряме додавання без вибору видання', () => {
    it('одне натискання: Work з назвою, авторами й роком першої публікації, Edition лише з обкладинкою, один Copy і посилання', async () => {
      const user = await registerAccount(app, 'olw-direct')
      const id = workId()
      const shown = record(id, {
        authors: ['Roald Dahl', 'Quentin Blake'],
        firstPublishedYear: 1970,
        coverUrl: COVER,
        // Мова твору в записі — не мова видання в руках людини: її не зберігаємо.
        language: 'en',
      })

      works.respondWith(shown)

      const result = await added(user, target(id))
      const stored = await prisma.edition.findUniqueOrThrow({
        where: { id: result.edition.id },
        include: {
          work: {
            include: { authors: { include: { author: true }, orderBy: { position: 'asc' } } },
          },
          copies: true,
          externalReferences: true,
        },
      })

      expect(result.replayed).toBe(false)
      expect(result.work).toMatchObject({ title: shown.title, firstPubYear: 1970, origLang: null })
      expect(result.authors.map((author) => author.name)).toEqual(['Roald Dahl', 'Quentin Blake'])
      // Невідоме лишається невідомим: рік першої публікації — не рік видання.
      expect(result.edition).toMatchObject({
        coverUrl: COVER,
        year: null,
        publisher: null,
        isbn13: null,
        pageCount: null,
        format: null,
        lang: null,
        textKind: 'UNKNOWN',
        translationId: null,
      })
      expect(stored.copies).toHaveLength(1)
      expect(stored.copies[0]).toMatchObject({ ownerId: user.id, currentHolderId: user.id })
      // ID твору джерела не видається за ID видання.
      expect(stored.externalReferences).toEqual([])
      expect(await prisma.editionExternalReference.count({ where: { externalId: id } })).toBe(0)
      expect(await referenceOf(id)).toMatchObject({
        workId: result.work.id,
        editionId: result.edition.id,
      })
      expect(
        await prisma.libraryAddOperation.findFirstOrThrow({ where: { copyId: result.copy.id } }),
      ).toMatchObject({ targetKind: 'EXTERNAL_WORK', editionId: result.edition.id })
    })

    it('бібліотека віддає збережені обкладинку, назву, авторів і рік першої публікації', async () => {
      const user = await registerAccount(app, 'olw-library')
      const id = workId()
      const shown = record(id, { authors: ['Автор'], firstPublishedYear: 1931, coverUrl: COVER })

      works.respondWith(shown)

      const result = await added(user, target(id))
      const library = libraryResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .get(url('/me/library'))
            .set('Cookie', user.cookie)
            .expect(200)
        ).body,
      )
      const group = library.groups.find((item) => item.edition.id === result.edition.id)

      expect(group).toMatchObject({
        edition: { coverUrl: COVER, year: null },
        work: { title: shown.title, firstPubYear: 1931 },
        authors: [{ name: 'Автор' }],
      })
    })

    it('запис без авторів, року й обкладинки: нічого не вигадано', async () => {
      const user = await registerAccount(app, 'olw-bare')
      const id = workId()

      works.respondWith(record(id))

      const result = await added(user, target(id))

      expect(result.authors).toEqual([])
      expect(result.work).toMatchObject({ firstPubYear: null, origLang: null })
      expect(result.edition).toMatchObject({ coverUrl: null, year: null, lang: null })
      expect(await prisma.workAuthor.count({ where: { workId: result.work.id } })).toBe(0)
    })

    it('запис, якого джерело не знає, — 404, нічого не створено', async () => {
      const user = await registerAccount(app, 'olw-missing')
      const id = workId()
      const response = await post(user, { operationId: randomUUID(), target: target(id) }).expect(
        404,
      )

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.CATALOG_LOOKUP_NOT_FOUND,
      )
      expect(await referenceOf(id)).toBeNull()
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(0)
    })

    it('збій чи таймаут джерела — нічого не записано; той самий намір потім спрацьовує тим самим operationId', async () => {
      const user = await registerAccount(app, 'olw-down')
      const id = workId()
      const body = { operationId: randomUUID(), target: target(id) }

      works.respondWithError(id)
      expect(apiErrorSchema.parse((await post(user, body).expect(502)).body).code).toBe(
        API_ERROR_CODES.CATALOG_LOOKUP_PROVIDER_ERROR,
      )

      process.env.CATALOG_LOOKUP_TIMEOUT_MS = '50'
      works.hang(id)
      expect(apiErrorSchema.parse((await post(user, body).expect(504)).body).code).toBe(
        API_ERROR_CODES.CATALOG_LOOKUP_TIMEOUT,
      )
      expect(await referenceOf(id)).toBeNull()
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)

      works.respondWith(record(id))

      const result = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)

      expect(result.replayed).toBe(false)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(1)
    })
  })

  describe('повторне додавання знаходить уже створене', () => {
    it('інший користувач додає той самий запис без мережі: той самий Work і Edition, власний Copy', async () => {
      const one = await registerAccount(app, 'olw-again-a')
      const two = await registerAccount(app, 'olw-again-b')
      const id = workId()

      works.respondWith(record(id, { coverUrl: COVER }))

      const first = await added(one, target(id))

      works.clear()

      const second = await added(two, target(id))

      expect(works.calls).toEqual([])
      expect(second.work.id).toBe(first.work.id)
      expect(second.edition.id).toBe(first.edition.id)
      expect(second.copy.id).not.toBe(first.copy.id)
      expect(await prisma.edition.count({ where: { workId: first.work.id } })).toBe(1)
    })

    it('«ще один примірник» — нова операція: той самий Edition, другий Copy; той самий operationId — той самий Copy', async () => {
      const user = await registerAccount(app, 'olw-another')
      const id = workId()
      const body = { operationId: randomUUID(), target: target(id) }

      works.respondWith(record(id))

      const first = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)
      const replay = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)
      const another = await added(user, target(id))

      expect(replay).toMatchObject({ replayed: true, copy: { id: first.copy.id } })
      expect(another.edition.id).toBe(first.edition.id)
      expect(another.copy.id).not.toBe(first.copy.id)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(2)
    })

    it('вісім паралельних повторів тієї самої дії: один Work, одне Edition, один Copy', async () => {
      const user = await registerAccount(app, 'olw-parallel')
      const id = workId()
      const title = token()
      const body = { operationId: randomUUID(), target: target(id) }

      works.respondWith(record(id, { title }))

      const responses = await Promise.all(Array.from({ length: 8 }, () => post(user, body)))

      expect(responses.map((response) => response.status)).toEqual(Array(8).fill(201))
      expect(await prisma.work.count({ where: { title } })).toBe(1)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(1)
      expect(await prisma.workExternalReference.count({ where: { externalId: id } })).toBe(1)
    })

    it('двоє користувачів уперше додають один запис одночасно: один Work, одне Edition, одне посилання, два Copy', async () => {
      const one = await registerAccount(app, 'olw-race-a')
      const two = await registerAccount(app, 'olw-race-b')
      const id = workId()
      const title = token()

      works.respondWith(record(id, { title, authors: ['Змагання'] }))

      // Обидва вже отримали метадані джерела, і жоден ще не почав транзакцію.
      const release = works.holdResponses()
      const first = beginRequest(post(one, { operationId: randomUUID(), target: target(id) }))
      const second = beginRequest(post(two, { operationId: randomUUID(), target: target(id) }))

      while (works.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))

      release()

      const [a, b] = await Promise.all([first, second])

      expect([a.status, b.status]).toEqual([201, 201])

      const [ra, rb] = [a, b].map((response) => quickAddResponseSchema.parse(response.body))

      expect(ra?.edition.id).toBe(rb?.edition.id)
      expect(await prisma.work.count({ where: { title } })).toBe(1)
      expect(
        await prisma.author.count({
          where: { name: 'Змагання', works: { some: { work: { title } } } },
        }),
      ).toBe(1)
      expect(await prisma.workExternalReference.count({ where: { externalId: id } })).toBe(1)
      expect(await prisma.copy.count({ where: { editionId: ra?.edition.id } })).toBe(2)
    })

    it('збіг назви й автора з іншим записом нічого не зв’язує: інший OL…W — інший твір', async () => {
      const user = await registerAccount(app, 'olw-namesake')
      const title = token()
      const first = workId()
      const second = workId()

      works.respondWith(record(first, { title, authors: ['Тезка'] }))
      works.respondWith(record(second, { title, authors: ['Тезка'] }))

      const a = await added(user, target(first))
      const b = await added(user, target(second))

      expect(b.work.id).not.toBe(a.work.id)
      expect(b.edition.id).not.toBe(a.edition.id)
    })

    it('інший вміст з тим самим operationId — 409 і без звернення до джерела', async () => {
      const user = await registerAccount(app, 'olw-conflict')
      const id = workId()
      const operationId = randomUUID()

      works.respondWith(record(id))
      await post(user, { operationId, target: target(id) }).expect(201)
      works.clear()

      const response = await post(user, {
        operationId,
        target: target(id, { edition: { publisher: 'Інше' } }),
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.LIBRARY_ADD_OPERATION_CONFLICT,
      )
      expect(works.calls).toEqual([])
    })

    it('після злиття твору додавання потрапляє на канонічний твір', async () => {
      const user = await registerAccount(app, 'olw-merged')
      const id = workId()

      works.respondWith(record(id, { coverUrl: COVER }))

      const first = await added(user, target(id))
      const canonical = await request(app.getHttpServer())
        .post(url('/works'))
        .set('Cookie', user.cookie)
        .send({ title: token(), origLang: 'en', authors: [{ name: token() }] })
        .expect(201)
      const canonicalId = (canonical.body as { work: { id: string } }).work.id
      const context = await Test.createTestingModule({ imports: [MergeCliModule] }).compile()

      await context.init()

      try {
        await context.get(MergeService).merge(first.work.id, canonicalId)
      } finally {
        await context.close()
      }

      const direct = await added(user, target(id))
      const refined = await added(user, target(id, { edition: { publisher: 'Після злиття' } }))

      expect(direct.edition.id).toBe(first.edition.id)
      expect(direct.work.id).toBe(canonicalId)
      expect(refined.work.id).toBe(canonicalId)
    })
  })

  describe('повторний пошук', () => {
    async function external(account: Account, query: string) {
      const response = await request(app.getHttpServer())
        .get(url(`/me/library/add-search/external?q=${encodeURIComponent(query)}`))
        .set('Cookie', account.cookie)
        .expect(200)

      return addSearchExternalResponseSchema.parse(response.body)
    }

    it('доданий запис твору повертається НАШИМ виданням зі станом «у моїй бібліотеці»; інший запис з тією ж назвою — зовнішній', async () => {
      const user = await registerAccount(app, 'olw-search')
      const other = await registerAccount(app, 'olw-search-other')
      const word = token()
      const id = workId()
      const namesake = workId()
      // Назва, яку локальний пошук за `word` не знаходить: зіставлення — лише за посиланням.
      const shown = record(id, { title: `Інша назва ${token()}`, coverUrl: COVER })

      works.respondWith(shown)

      const result = await added(user, target(id))

      openLibrary.returns([shown, record(namesake, { title: shown.title })])

      const mine = await external(user, word)

      expect(mine.items.map((item) => item.kind)).toEqual(['EDITION', 'EXTERNAL'])
      expect(mine.items[0]).toMatchObject({
        kind: 'EDITION',
        key: `edition:${result.edition.id}`,
        edition: { coverUrl: COVER },
        ownership: { activeCount: 1, archivedCount: 0 },
      })
      expect(mine.items[1]).toMatchObject({
        kind: 'EXTERNAL',
        key: `external:OPEN_LIBRARY:${namesake}`,
      })

      app.get(ExternalSearchCache).clear()

      const theirs = await external(other, word)

      expect(theirs.items[0]).toMatchObject({
        key: `edition:${result.edition.id}`,
        ownership: { activeCount: 0, archivedCount: 0 },
      })
    })

    it('локальний пошук уже показує доданий твір — той самий запис не повторюється в зовнішній половині', async () => {
      const user = await registerAccount(app, 'olw-search-dup')
      const word = token()
      const id = workId()
      const shown = record(id, { title: `${word} Fantastic` })

      works.respondWith(shown)

      const result = await added(user, target(id))
      const local = addSearchResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .get(url(`/me/library/add-search?q=${encodeURIComponent(word)}`))
            .set('Cookie', user.cookie)
            .expect(200)
        ).body,
      )

      openLibrary.returns([shown, record(workId(), { title: `${word} Інший` })])

      const external = await (async () => {
        const response = await request(app.getHttpServer())
          .get(url(`/me/library/add-search/external?q=${encodeURIComponent(word)}`))
          .set('Cookie', user.cookie)
          .expect(200)

        return addSearchExternalResponseSchema.parse(response.body)
      })()

      expect(local.items.map((item) => item.key)).toEqual([`edition:${result.edition.id}`])
      expect(external.items.map((item) => item.key)).not.toContain(`edition:${result.edition.id}`)
      expect(external.items.map((item) => item.key)).not.toContain(`external:OPEN_LIBRARY:${id}`)
      expect(external.items).toHaveLength(1)
    })

    it('твір, пов’язаний лише через «Уточнити дані», лишається зовнішнім записом: інше видання — не «ця книжка вже у вас»', async () => {
      const user = await registerAccount(app, 'olw-search-refined')
      const word = token()
      const id = workId()
      const shown = record(id, { title: `Уточнена ${token()}` })

      works.respondWith(shown)
      await added(user, target(id, { edition: { publisher: 'Конкретне' } }))
      openLibrary.returns([shown])

      const result = await external(user, word)

      expect(result.items).toEqual([
        expect.objectContaining({ kind: 'EXTERNAL', key: `external:OPEN_LIBRARY:${id}` }),
      ])
    })
  })

  describe('атомарність', () => {
    it('помилка після створення Copy відкочує Work, Author, Edition, посилання й операцію', async () => {
      const user = await registerAccount(app, 'olw-rollback')
      const id = workId()
      const title = token()
      const authorName = `Відкат ${token()}`
      const real = new CopyWriter()
      const failing = await createTestApp({
        configure: (builder) => {
          builder.overrideProvider(EXTERNAL_WORK_PROVIDER).useValue(works)
          builder.overrideProvider(CopyWriter).useValue({
            create: async (...args: Parameters<CopyWriter['create']>) => {
              await real.create(...args)

              throw new Error('примусова помилка після запису Copy')
            },
          })
        },
      })
      const body = { operationId: randomUUID(), target: target(id) }

      works.respondWith(record(id, { title, authors: [authorName], coverUrl: COVER }))

      try {
        await post(user, body, failing).expect(500)
      } finally {
        await failing.close()
      }

      expect(await prisma.work.count({ where: { title } })).toBe(0)
      expect(await prisma.author.count({ where: { name: authorName } })).toBe(0)
      expect(await referenceOf(id)).toBeNull()
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(0)
    })
  })

  describe('«Уточнити дані» запису твору', () => {
    it('додані поля видання — нове видання ТОГО САМОГО пов’язаного твору з обкладинкою запису; пряме додавання потім не створює другого твору', async () => {
      const user = await registerAccount(app, 'olw-refine')
      const id = workId()
      const number = uniqueIsbn13('olw-refine')

      works.respondWith(
        record(id, { authors: ['Автор'], firstPublishedYear: 1925, coverUrl: COVER }),
      )

      const refined = await added(
        user,
        target(id, {
          edition: { isbn13: number, publisher: 'А-ба-ба-га-ла-ма-га', year: 2019, lang: 'uk' },
        }),
      )

      expect(refined.work).toMatchObject({ firstPubYear: 1925 })
      expect(refined.edition).toMatchObject({
        isbn13: number,
        publisher: 'А-ба-ба-га-ла-ма-га',
        year: 2019,
        lang: 'uk',
        coverUrl: COVER,
        textKind: 'UNKNOWN',
      })
      // Уточнення пов'язало твір, але видання «без уточнення» ще не створювало.
      expect(await referenceOf(id)).toMatchObject({ workId: refined.work.id, editionId: null })

      const direct = await added(user, target(id))

      expect(direct.work.id).toBe(refined.work.id)
      expect(direct.edition.id).not.toBe(refined.edition.id)
      expect(direct.edition).toMatchObject({ isbn13: null, publisher: null, coverUrl: COVER })
      expect(await referenceOf(id)).toMatchObject({ editionId: direct.edition.id })
      expect(await prisma.work.count({ where: { title: refined.work.title } })).toBe(1)
    })

    it('людина замінила обкладинку чи прибрала її (null) — береться її рішення', async () => {
      const user = await registerAccount(app, 'olw-cover')
      const id = workId()
      const own = 'https://example.com/own-cover.jpg'

      works.respondWith(record(id, { coverUrl: COVER }))

      const replaced = await added(user, target(id, { edition: { coverUrl: own } }))
      const cleared = await added(user, target(id, { edition: { coverUrl: null } }))

      expect(replaced.edition.coverUrl).toBe(own)
      expect(cleared.edition.coverUrl).toBeNull()
    })

    it('переклад і тип тексту проходять ті самі правила, що й ручна форма', async () => {
      const user = await registerAccount(app, 'olw-translation')
      const id = workId()

      works.respondWith(record(id))

      const result = await added(
        user,
        target(id, {
          edition: { textKind: 'TRANSLATION', lang: 'uk' },
          translation: { translator: 'Перекладачка', lang: 'uk', sourceLang: 'en' },
        }),
      )

      expect(result.edition).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk' })
      expect(result.edition.translationId).not.toBeNull()
    })

    it('ISBN, що вже є в каталозі, — EDITION_ISBN_TAKEN з наявним виданням, нічого не створено', async () => {
      const user = await registerAccount(app, 'olw-taken')
      const id = workId()
      const number = uniqueIsbn13('olw-taken')
      const title = token()

      works.respondWith(record(id, { title }))
      volumes.respondWith('gb-olw-taken', volume('gb-olw-taken', { isbn13: number }))

      const existing = await added(user, {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: 'gb-olw-taken',
      })
      const response = await post(user, {
        operationId: randomUUID(),
        target: target(id, { edition: { isbn13: number } }),
      }).expect(409)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.EDITION_ISBN_TAKEN)
      expect(error.details).toMatchObject({ editionId: existing.edition.id })
      expect(await prisma.work.count({ where: { title } })).toBe(0)
      expect(await referenceOf(id)).toBeNull()
    })
  })

  describe('«Уточнити дані» видання Google Books', () => {
    it('підтверджене джерелом лишається, додане людиною заповнює прогалини, посилання збережено', async () => {
      const user = await registerAccount(app, 'gb-refine')
      const number = uniqueIsbn13('gb-refine')

      volumes.respondWith(
        'gb-refine',
        volume('gb-refine', { isbn13: number, publisher: 'Джерело', authors: ['Авторка'] }),
      )

      const result = await added(user, {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: 'gb-refine',
        edition: { textKind: 'TRANSLATION', lang: 'uk', publisher: 'Клієнт', pageCount: 320 },
        translation: { translator: 'Перекладач', lang: 'uk', sourceLang: 'en' },
      })

      expect(result.edition).toMatchObject({
        isbn13: number,
        publisher: 'Джерело',
        pageCount: 320,
        textKind: 'TRANSLATION',
        lang: 'uk',
      })
      expect(result.edition.translationId).not.toBeNull()
      expect(result.authors.map((author) => author.name)).toEqual(['Авторка'])
      expect(
        await prisma.editionExternalReference.findUnique({
          where: { source_externalId: { source: 'GOOGLE_BOOKS', externalId: 'gb-refine' } },
        }),
      ).toMatchObject({ editionId: result.edition.id })
    })

    it('уточнення видання, яке вже є в каталозі, — EDITION_ISBN_TAKEN: спільне видання мовчки не змінюється', async () => {
      const user = await registerAccount(app, 'gb-refine-known')
      const number = uniqueIsbn13('gb-refine-known')

      volumes.respondWith('gb-known', volume('gb-known', { isbn13: number }))

      const first = await added(user, {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: 'gb-known',
      })
      const response = await post(user, {
        operationId: randomUUID(),
        target: {
          kind: 'EXTERNAL_EDITION',
          source: 'GOOGLE_BOOKS',
          externalId: 'gb-known',
          edition: { pageCount: 99 },
        },
      }).expect(409)

      expect(apiErrorSchema.parse(response.body)).toMatchObject({
        code: API_ERROR_CODES.EDITION_ISBN_TAKEN,
        details: { editionId: first.edition.id },
      })
      expect(
        await prisma.edition.findUniqueOrThrow({ where: { id: first.edition.id } }),
      ).toMatchObject({ pageCount: null })
    })
  })

  describe('валідація', () => {
    it.each([
      ['ID видання Open Library', target('OL123M')],
      ['назва від клієнта', target('OL1W', { title: 'Назва' })],
      ['джерело без записів творів', { ...target('OL1W'), source: 'GOOGLE_BOOKS' }],
    ])('%s — 400', async (_name, body) => {
      const user = await registerAccount(app, 'olw-invalid')

      await post(user, { operationId: randomUUID(), target: body }).expect(400)
      expect(works.calls).toEqual([])
    })
  })

  function volume(
    id: string,
    over: Partial<BookLookupResult> & { isbn13?: string | undefined } = {},
  ): GoogleVolumeRecord {
    const { isbn13, ...result } = over

    return {
      externalId: id,
      ...(isbn13 === undefined ? {} : { isbn13 }),
      result: { title: token(), externalId: id, ...result },
    }
  }
})
