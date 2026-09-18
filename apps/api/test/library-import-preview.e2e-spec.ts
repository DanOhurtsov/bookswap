import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  LIBRARY_IMPORT_CONTENT_BASE64_MAX,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  libraryImportDraftResponseSchema,
  libraryImportTooLargeDetailsSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
} from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import {
  csvContent,
  errorCodesOf,
  importUrl,
  preview,
  rowOf,
  toBase64,
} from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8f-2, R4–R7: `POST /me/library/imports/preview` and
 * `GET /me/library/imports/:id`.
 *
 * The provider is faked at the transport port, so nothing here touches the
 * network — but the cache, the resolver, the candidate ranking and the draft
 * persistence are all the real ones.
 */
describe('CSV import preview (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  let strangerCookie: string
  const fake = new FakeBatchLookupProvider()

  /** Domain tables a preview must never touch (R5). */
  async function domainCounts(): Promise<Record<string, number>> {
    const [work, author, workAuthor, translation, edition, copy, loan] = await Promise.all([
      prisma.work.count(),
      prisma.author.count(),
      prisma.workAuthor.count(),
      prisma.translation.count(),
      prisma.edition.count(),
      prisma.copy.count(),
      prisma.loan.count(),
    ])

    return { work, author, workAuthor, translation, edition, copy, loan }
  }

  async function register(prefix: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Імпортер' })
      .expect(201)

    return sessionCookie(response.headers)
  }

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
      },
    })
    prisma = app.get(PrismaService)
    cookie = await register('import-owner')
    strangerCookie = await register('import-stranger')
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  const isbn = (): string => uniqueIsbn13('library-import-preview')

  let markers = 0

  /**
   * A distinct, share-nothing token per title. Titles that merely differ by a
   * digit would rank as similar to each other in trigram search, and the
   * candidate assertions below would be testing the marker, not the catalog.
   */
  const marker = (): string => {
    markers += 1

    return `${Math.random().toString(36).slice(2, 8)}${markers.toString(36)}`
  }

  /**
   * A title no other test's data can rank against: the base word is unique to
   * this file, and candidate search reads the whole catalog, not just this
   * draft.
   */
  const freshTitle = (): string => `Зорепад ${marker()}`

  /** A real `Work` + `Edition` through the public API — the local half of resolution. */
  async function createEdition(input: { title: string; author: string; isbn13: string }) {
    const work = await request(app.getHttpServer())
      .post(`${API_PREFIX}/works`)
      .set('Cookie', cookie)
      .send({ title: input.title, origLang: 'en', authors: [{ name: input.author }] })
      .expect(201)
    const workId = (work.body as { work: { id: string } }).work.id

    const edition = await request(app.getHttpServer())
      .post(`${API_PREFIX}/works/${workId}/editions`)
      .set('Cookie', cookie)
      .send({ isbn13: input.isbn13, format: 'PAPERBACK' })
      .expect(201)

    return { workId, editionId: (edition.body as { edition: { id: string } }).edition.id }
  }

  describe('доступ', () => {
    it.each([
      ['post', '/preview'],
      ['get', '/some-import'],
      ['patch', '/some-import/rows/1'],
    ] as const)('%s %s без кукі — 401 з машиночитним code', async (method, path) => {
      const response = await request(app.getHttpServer())
        [method](importUrl(path))
        .send({})
        .expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })

    it('чужий і неіснуючий імпорт — однакова відповідь 404', async () => {
      const draft = await preview(app, cookie, [
        { isbn13: isbn(), title: 'Т', authors: 'А', orig_lang: 'en' },
      ])

      const foreign = await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', strangerCookie)
        .expect(404)
      const missing = await request(app.getHttpServer())
        .get(importUrl('/cl00000000000000000000000'))
        .set('Cookie', cookie)
        .expect(404)

      expect(apiErrorSchema.parse(foreign.body)).toEqual(apiErrorSchema.parse(missing.body))
      expect(apiErrorSchema.parse(foreign.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })
  })

  describe('змішаний preview', () => {
    let draft: LibraryImportDraftResponse
    let existing: { workId: string; editionId: string }
    let ambiguousTitle: string
    /** Snapshot: `afterEach` clears the fake between tests, `beforeAll` ran once. */
    let batches: string[][]
    const isbns = {
      local: isbn(),
      fresh: isbn(),
      ambiguous: isbn(),
      unknown: isbn(),
      broken: isbn(),
    }

    beforeAll(async () => {
      const herbert = `Герберт ${marker()}`

      ambiguousTitle = `Дюна ${marker()}`
      existing = await createEdition({
        title: `Гобіт ${marker()}`,
        author: `Толкін ${marker()}`,
        isbn13: isbns.local,
      })
      await createEdition({ title: ambiguousTitle, author: herbert, isbn13: isbn() })

      fake.respondWith(isbns.fresh, {
        title: freshTitle(),
        authors: [`Підмогильний ${marker()}`],
      })
      fake.respondWith(isbns.ambiguous, { title: ambiguousTitle, authors: [herbert] })
      fake.respondNotFound(isbns.unknown)
      fake.respondUnavailable(isbns.broken, 'TIMEOUT')

      draft = await preview(app, cookie, [
        { isbn13: isbns.local },
        { isbn13: isbns.fresh, orig_lang: 'en' },
        { isbn13: isbns.ambiguous, orig_lang: 'en' },
        { isbn13: '9780306406158' },
        { isbn13: isbns.unknown },
        { isbn13: isbns.broken, orig_lang: 'en' },
      ])
      batches = fake.batches.map((batch) => [...batch])
    })

    it('локальне видання резолвиться без жодного зовнішнього виклику', () => {
      expect(rowOf(draft, 1).status).toBe('READY_EXISTING_EDITION')
      expect(rowOf(draft, 1).resolution).toEqual({
        kind: 'EXISTING_EDITION',
        editionId: existing.editionId,
        workId: existing.workId,
      })
      expect(batches.flat()).not.toContain(isbns.local)
    })

    it('знайдена провайдером книга без схожих творів готова до створення ланцюга', () => {
      const row = rowOf(draft, 2)

      expect(row.status).toBe('READY_CREATE_CHAIN')
      expect(row.resolution).toMatchObject({ kind: 'CREATE_CHAIN', workId: null })
      expect(row.errors).toEqual([])
    })

    /** Agreed 8f-2 rule: even one similar work is a question, never a silent choice. */
    it('схожий твір у каталозі робить рядок NEEDS_REVIEW з кандидатами', () => {
      const row = rowOf(draft, 3)

      expect(row.status).toBe('NEEDS_REVIEW')
      expect(row.resolution).toBeNull()
      expect(errorCodesOf(draft, 3)).toEqual(['AMBIGUOUS_CATALOG_MATCH'])
      // Contains, not equals: candidate search looks at the whole catalog, and
      // another test's data must not be able to break this assertion.
      expect(
        row.errors[0]?.code === 'AMBIGUOUS_CATALOG_MATCH'
          ? row.errors[0].candidates.map((candidate) => candidate.title)
          : [],
      ).toContain(ambiguousTitle)
    })

    it('зламана контрольна сума ISBN — INVALID без звернення до провайдера', () => {
      expect(rowOf(draft, 4).status).toBe('INVALID')
      expect(errorCodesOf(draft, 4)).toEqual(['INVALID_ISBN'])
      expect(batches.flat()).not.toContain('9780306406158')
    })

    it('провайдер не знає ISBN — LOOKUP_NOT_FOUND і перелік потрібних колонок', () => {
      expect(rowOf(draft, 5).status).toBe('NEEDS_REVIEW')
      expect(errorCodesOf(draft, 5)).toEqual(['LOOKUP_NOT_FOUND', 'MISSING_CATALOG_DATA'])
      expect(rowOf(draft, 5).errors[1]).toMatchObject({ fields: ['title', 'authors', 'orig_lang'] })
    })

    /** R7: a timeout is not "no such book" — the row stays retryable. */
    it('timeout провайдера — retryable LOOKUP_UNAVAILABLE, а не «не знайдено»', () => {
      expect(rowOf(draft, 6).status).toBe('NEEDS_REVIEW')
      expect(rowOf(draft, 6).errors[0]).toEqual({
        code: 'LOOKUP_UNAVAILABLE',
        reason: 'TIMEOUT',
        retryable: true,
      })
    })

    it('counts і readiness рахує сервер, і commit заблокований', () => {
      expect(draft.counts).toEqual({
        readyExistingEdition: 1,
        readyCreateChain: 1,
        needsReview: 3,
        invalid: 1,
        skipped: 0,
      })
      expect(draft.readiness.canCommit).toBe(false)
    })

    it('усі невідомі ISBN пішли одним batch-викликом', () => {
      expect(batches).toHaveLength(1)
      expect(batches[0]?.sort()).toEqual(
        [isbns.fresh, isbns.ambiguous, isbns.unknown, isbns.broken].sort(),
      )
    })
  })

  it('preview не створює жодної доменної сутності', async () => {
    const before = await domainCounts()
    const found = isbn()

    fake.respondWith(found, { title: `Книга ${marker()}`, authors: ['Автор'] })
    await preview(app, cookie, [
      { isbn13: found, orig_lang: 'en' },
      { isbn13: isbn() },
      { isbn13: 'не isbn' },
    ])

    expect(await domainCounts()).toEqual(before)
  })

  it('повторний preview того самого файла повертає той самий import без нових викликів', async () => {
    const rows = [{ isbn13: isbn(), title: `Книга ${marker()}`, authors: 'Автор', orig_lang: 'en' }]
    const first = await preview(app, cookie, rows)
    const asked = fake.askedCount

    const second = await preview(app, cookie, rows)

    expect(second.import.id).toBe(first.import.id)
    expect(second.rows).toEqual(first.rows)
    expect(fake.askedCount).toBe(asked)
  })

  /** R6a: line endings are part of the hash, so the same text with CRLF is a different file. */
  it('той самий текст з іншими закінченнями рядків — інший імпорт', async () => {
    const rows: Partial<LibraryImportCsvCells>[] = [
      { isbn13: isbn(), title: `Книга ${marker()}`, authors: 'Автор', orig_lang: 'en' },
    ]
    const lf = await preview(app, cookie, rows)
    const crlf = await request(app.getHttpServer())
      .post(importUrl('/preview'))
      .set('Cookie', cookie)
      .send({ contentBase64: toBase64(csvContent(rows).replaceAll('\n', '\r\n')) })
      .expect(201)

    expect(libraryImportDraftResponseSchema.parse(crlf.body).import.id).not.toBe(lf.import.id)
  })

  it('кеш lookup ділиться між файлами — другий preview не питає провайдера', async () => {
    const shared = isbn()

    fake.respondWith(shared, { title: `Спільна ${marker()}`, authors: ['Автор'] })
    await preview(app, cookie, [{ isbn13: shared, orig_lang: 'en' }])
    const asked = fake.askedCount

    await preview(app, cookie, [{ isbn13: shared, orig_lang: 'en', note: 'інший файл' }])

    expect(fake.askedCount).toBe(asked)
  })

  describe('прострочення (R6a)', () => {
    it('власна прострочена чернетка — IMPORT_EXPIRED, і оживає лише файлом', async () => {
      const rows = [
        { isbn13: isbn(), title: `Книга ${marker()}`, authors: 'Автор', orig_lang: 'en' },
      ]
      const draft = await preview(app, cookie, rows)

      await prisma.libraryImport.update({
        where: { id: draft.import.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      const expired = await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', cookie)
        .expect(410)

      expect(apiErrorSchema.parse(expired.body).code).toBe(API_ERROR_CODES.IMPORT_EXPIRED)
      // Rows (and the private note in them) are gone, not merely hidden.
      expect(await prisma.libraryImportRow.count({ where: { importId: draft.import.id } })).toBe(0)

      const revived = await preview(app, cookie, rows)

      expect(revived.import.id).toBe(draft.import.id)
      expect(revived.import.status).toBe('DRAFT')
      expect(revived.rows).toHaveLength(1)
      expect(new Date(revived.import.expiresAt).getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('помилки файла', () => {
    function send(contentBase64: string): request.Test {
      return request(app.getHttpServer())
        .post(importUrl('/preview'))
        .set('Cookie', cookie)
        .send({ contentBase64 })
    }

    it('некоректний base64 — VALIDATION_ERROR, а не мовчазне обрізання', async () => {
      const response = await send('data:text/csv;base64,aXNibjEz').expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('невалідний UTF-8 — IMPORT_INVALID_CSV/INVALID_ENCODING', async () => {
      const bytes = Buffer.concat([
        Buffer.from(`${LIBRARY_IMPORT_CSV_HEADER.join(',')}\n`),
        Buffer.from([0xff, 0xfe, 0x0a]),
      ])
      const response = await send(bytes.toString('base64')).expect(400)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.IMPORT_INVALID_CSV)
      expect(error.details).toEqual({ reason: 'INVALID_ENCODING' })
    })

    it('рівно 48 KiB проходить, а більший файл дає IMPORT_TOO_LARGE з реальним розміром', async () => {
      const header = `${LIBRARY_IMPORT_CSV_HEADER.join(',')}\n`
      const row = (note: string): string =>
        csvContent([{ isbn13: isbn(), note }]).slice(header.length)
      const base = header + row('')
      const padding = LIBRARY_IMPORT_LIMITS.maxBytes - Buffer.byteLength(base)
      const atLimit = header + row('x'.repeat(padding))

      expect(Buffer.byteLength(atLimit)).toBe(LIBRARY_IMPORT_LIMITS.maxBytes)
      await send(toBase64(atLimit)).expect(201)

      const response = await send(toBase64(`${atLimit}x`)).expect(413)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.IMPORT_TOO_LARGE)
      expect(error.details).toEqual({
        limit: 'BYTES',
        max: LIBRARY_IMPORT_LIMITS.maxBytes,
        actual: LIBRARY_IMPORT_LIMITS.maxBytes + 1,
      })
    })

    /**
     * The transport limit, not the file limit: this body never reaches the
     * parser at all, so the answer cannot claim to know the CSV's size. Before
     * this was handled, body-parser's own rejection reached the global filter
     * unrecognized and came back as 500 INTERNAL_ERROR — a server fault
     * reported for a request that was simply too big.
     */
    it('перевищення транспортного ліміту — контрольований 413, а не 500', async () => {
      const overLimit = 'A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX + 4_000)
      const response = await send(overLimit).expect(413)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.IMPORT_TOO_LARGE)
      expect(error.details).toMatchObject({ limit: 'REQUEST_BYTES' })
      expect(libraryImportTooLargeDetailsSchema.parse(error.details)).toEqual(error.details)
    })

    it('відповідь на завелике тіло не містить самого тіла', async () => {
      const secret = `секрет-${marker()}`
      const padding = 'A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX + 4_000)
      const response = await request(app.getHttpServer())
        .post(importUrl('/preview'))
        .set('Cookie', cookie)
        .send({ contentBase64: padding, note: secret })
        .expect(413)

      expect(JSON.stringify(response.body)).not.toContain(secret)
      expect(JSON.stringify(response.body)).not.toContain('AAAA')
    })

    /**
     * The import parser is mounted on one path only, and it must stay that way:
     * registering it under body-parser's own middleware name would make Nest
     * skip its global JSON parser and every other endpoint would silently see
     * an empty body.
     */
    it('інші маршрути далі розбирають JSON-тіло', async () => {
      const response = await request(app.getHttpServer())
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: 'не-той@example.com', password: VALID_PASSWORD })

      // Wrong credentials, not "email must be a string": the body was parsed.
      expect(response.status).toBe(401)
      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.INVALID_CREDENTIALS)
    })

    /** R4: raw CSV and the private note never leave through a diagnostic error. */
    it('помилка файла не віддає його вміст', async () => {
      const secret = `секрет-${marker()}`
      const broken = `не_та_колонка,друга\n${secret},2\n`
      const response = await send(toBase64(broken)).expect(400)

      expect(JSON.stringify(response.body)).not.toContain(secret)
    })
  })
})
