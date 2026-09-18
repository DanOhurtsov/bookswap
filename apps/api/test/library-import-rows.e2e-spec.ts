import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  LIBRARY_IMPORT_LIMITS,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
} from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { beginRequest, deferred, waitForBlockedBackend } from './concurrency.helpers'
import {
  csvContent,
  errorCodesOf,
  importUrl,
  patchRow,
  preview,
  rowOf,
  toBase64,
  versionOf,
} from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8f-2, §4: `PATCH /me/library/imports/:id/rows/:rowNumber`.
 *
 * Every case here checks the same two things from a different angle: the whole
 * draft is recomputed and returned, and nothing in the domain moves.
 */
describe('CSV import row PATCH (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  let strangerCookie: string
  const fake = new FakeBatchLookupProvider()

  async function domainCounts(): Promise<Record<string, number>> {
    const [work, author, workAuthor, translation, edition, copy] = await Promise.all([
      prisma.work.count(),
      prisma.author.count(),
      prisma.workAuthor.count(),
      prisma.translation.count(),
      prisma.edition.count(),
      prisma.copy.count(),
    ])

    return { work, author, workAuthor, translation, edition, copy }
  }

  async function register(prefix: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Рядковий' })
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
    cookie = await register('rows-owner')
    strangerCookie = await register('rows-stranger')
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  const isbn = (): string => uniqueIsbn13('library-import-rows')

  let markers = 0

  const marker = (): string => {
    markers += 1

    return `${Math.random().toString(36).slice(2, 8)}${markers.toString(36)}`
  }

  async function createWork(title: string, author: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/works`)
      .set('Cookie', cookie)
      .send({ title, origLang: 'en', authors: [{ name: author }] })
      .expect(201)

    return (response.body as { work: { id: string } }).work.id
  }

  /** A complete, provider-independent row: everything the chain needs is in the file. */
  function fullRow(overrides: Partial<LibraryImportCsvCells> = {}): Partial<LibraryImportCsvCells> {
    return {
      isbn13: isbn(),
      title: `Книга ${marker()}`,
      authors: `Автор ${marker()}`,
      orig_lang: 'en',
      edition_lang: 'en',
      ...overrides,
    }
  }

  describe('редагування перераховує весь draft', () => {
    it('виправлення ISBN переводить рядок з INVALID у готовий', async () => {
      const good = isbn()
      const draft = await preview(app, cookie, [
        { ...fullRow(), isbn13: '9780306406158' },
        fullRow(),
      ])

      expect(rowOf(draft, 1).status).toBe('INVALID')
      expect(draft.readiness.canCommit).toBe(false)

      const updated = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 1), cells: { isbn13: good } },
      )

      expect(rowOf(updated, 1).status).toBe('READY_CREATE_CHAIN')
      expect(updated.counts).toMatchObject({ invalid: 0, readyCreateChain: 2 })
      expect(updated.readiness).toEqual({ canCommit: true, copyCount: 2 })
      // The answer is the whole draft, not the one row that changed (R12).
      expect(updated.rows).toHaveLength(2)
    })

    /**
     * R5: a changed ISBN must not keep the edition the old one resolved to.
     */
    it('зміна ISBN скидає раніше вибране видання', async () => {
      const existingIsbn = isbn()
      const workId = await createWork(`Наявний ${marker()}`, `Автор ${marker()}`)

      await request(app.getHttpServer())
        .post(`${API_PREFIX}/works/${workId}/editions`)
        .set('Cookie', cookie)
        .send({ isbn13: existingIsbn, format: 'PAPERBACK' })
        .expect(201)

      const draft = await preview(app, cookie, [{ isbn13: existingIsbn }])

      expect(rowOf(draft, 1).resolution).toMatchObject({ kind: 'EXISTING_EDITION' })

      const other = isbn()

      fake.respondWith(other, { title: `Інша ${marker()}`, authors: [`Хтось ${marker()}`] })

      const updated = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        {
          action: 'EDIT',
          expectedRowVersion: versionOf(draft, 1),
          cells: { isbn13: other, orig_lang: 'en' },
        },
      )

      expect(rowOf(updated, 1).resolution).toMatchObject({ kind: 'CREATE_CHAIN' })
      expect(rowOf(updated, 1).status).toBe('READY_CREATE_CHAIN')
    })

    it('редагування не пише в домен і відхиляється цілком, якщо некоректне', async () => {
      const draft = await preview(app, cookie, [fullRow()])
      const before = await domainCounts()

      await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', cookie)
        .send({
          action: 'EDIT',
          expectedRowVersion: versionOf(draft, 1),
          cells: { not_a_column: 'x' },
        })
        .expect(400)

      const after = await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', cookie)
        .expect(200)

      expect((after.body as LibraryImportDraftResponse).rows).toEqual(draft.rows)
      expect(await domainCounts()).toEqual(before)
    })

    it('неіснуючий рядок — 404, чужий імпорт — теж 404', async () => {
      const draft = await preview(app, cookie, [fullRow()])

      await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/9`))
        .set('Cookie', cookie)
        .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) })
        .expect(404)
      await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', strangerCookie)
        .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) })
        .expect(404)
    })
  })

  describe('вибір твору', () => {
    it('CHOOSE знімає AMBIGUOUS_CATALOG_MATCH і фіксує твір у resolution', async () => {
      const title = `Мальви ${marker()}`
      const author = `Шевчук ${marker()}`
      const workId = await createWork(title, author)
      const rowIsbn = isbn()

      fake.respondWith(rowIsbn, { title, authors: [author] })

      const draft = await preview(app, cookie, [{ isbn13: rowIsbn, orig_lang: 'en' }])

      expect(errorCodesOf(draft, 1)).toEqual(['AMBIGUOUS_CATALOG_MATCH'])

      const chosen = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'CHOOSE', expectedRowVersion: versionOf(draft, 1), workId },
      )

      expect(rowOf(chosen, 1).status).toBe('READY_CREATE_CHAIN')
      expect(rowOf(chosen, 1).resolution).toMatchObject({ kind: 'CREATE_CHAIN', workId })
      expect(chosen.readiness.canCommit).toBe(true)
    })

    it('CHOOSE з null означає «створити новий твір»', async () => {
      const title = `Вітрила ${marker()}`
      const author = `Багряний ${marker()}`

      await createWork(title, author)

      const rowIsbn = isbn()

      fake.respondWith(rowIsbn, { title, authors: [author] })

      const draft = await preview(app, cookie, [{ isbn13: rowIsbn, orig_lang: 'en' }])
      const chosen = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'CHOOSE', expectedRowVersion: versionOf(draft, 1), workId: null },
      )

      expect(rowOf(chosen, 1).resolution).toMatchObject({ kind: 'CREATE_CHAIN', workId: null })
    })

    it('твір, якого рядку не пропонували, відхиляється без запису', async () => {
      const foreignWorkId = await createWork(`Ніяк не схоже ${marker()}`, `Хтось ${marker()}`)
      const draft = await preview(app, cookie, [fullRow()])

      await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', cookie)
        .send({
          action: 'CHOOSE',
          expectedRowVersion: versionOf(draft, 1),
          workId: foreignWorkId,
        })
        .expect(400)

      const after = await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', cookie)
        .expect(200)

      expect((after.body as LibraryImportDraftResponse).rows).toEqual(draft.rows)
    })
  })

  /**
   * Agreed 8f-2 rule: values that contradict each other need a decision, and
   * the cells stay exactly as they were entered. Before this, the translation
   * columns were silently dropped and the row reported itself READY with
   * `translation: null` — importing a book the owner never described.
   */
  describe('суперечливі дані рядка', () => {
    it('перекладач у виданні мовою оригіналу — NEEDS_REVIEW, а не READY', async () => {
      const entry = fullRow({ translator: 'Анатолій Пітик', is_abridged: 'true' })

      // The book itself is found: the only thing wrong with this row is that
      // its own values disagree.
      fake.respondWith(entry.isbn13 ?? '', { title: `Знайдена ${marker()}`, authors: ['Автор'] })

      const draft = await preview(app, cookie, [entry])
      const row = rowOf(draft, 1)

      expect(row.status).toBe('NEEDS_REVIEW')
      expect(row.resolution).toBeNull()
      expect(row.errors).toEqual([
        {
          code: 'CONFLICTING_CATALOG_DATA',
          fields: ['edition_lang', 'translator', 'is_abridged'],
        },
      ])
      // Nothing was thrown away: the cells still say what the file said.
      expect(row.cells.translator).toBe('Анатолій Пітик')
      expect(row.values?.translator).toBe('Анатолій Пітик')
      expect(draft.readiness.canCommit).toBe(false)
    })

    it('виправлення мови видання знімає суперечність', async () => {
      const entry = fullRow({ translator: 'Анатолій Пітик' })

      fake.respondWith(entry.isbn13 ?? '', { title: `Знайдена ${marker()}`, authors: ['Автор'] })

      const draft = await preview(app, cookie, [entry])
      const fixed = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 1), cells: { edition_lang: 'uk' } },
      )
      const row = rowOf(fixed, 1)

      expect(row.status).toBe('READY_CREATE_CHAIN')
      expect(row.resolution).toMatchObject({
        kind: 'CREATE_CHAIN',
        catalog: { translation: { lang: 'uk', sourceLang: 'en' } },
      })
    })

    /** Unknown original language is missing data, never guessed from the edition. */
    it('порожній orig_lang — MISSING_CATALOG_DATA, а не здогад із edition_lang', async () => {
      const draft = await preview(app, cookie, [
        { isbn13: isbn(), title: `Книга ${marker()}`, authors: 'Автор', edition_lang: 'uk' },
      ])

      expect(rowOf(draft, 1).status).toBe('NEEDS_REVIEW')
      expect(errorCodesOf(draft, 1)).toContain('MISSING_CATALOG_DATA')
      expect(rowOf(draft, 1).errors.at(-1)).toMatchObject({ fields: ['orig_lang'] })
    })
  })

  describe('дублікати (R6a)', () => {
    it('пропуск дубліката знімає помилку з першого рядка, зміна quantity — ні', async () => {
      const row = fullRow()
      const draft = await preview(app, cookie, [row, { ...row }])

      expect(errorCodesOf(draft, 2)).toEqual(['DUPLICATE_ROW'])
      expect(rowOf(draft, 1).status).toBe('READY_CREATE_CHAIN')

      // Quantity is not part of the duplicate key: changing it does not resolve
      // anything (R6a), and the row stays flagged.
      const requantified = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 2 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 2), cells: { quantity: '3' } },
      )

      expect(errorCodesOf(requantified, 2)).toEqual(['DUPLICATE_ROW'])

      const skipped = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 2 },
        { action: 'SKIP', expectedRowVersion: versionOf(requantified, 2) },
      )

      expect(rowOf(skipped, 2).status).toBe('SKIPPED')
      expect(skipped.counts).toMatchObject({ invalid: 0, skipped: 1, readyCreateChain: 1 })
      expect(skipped.readiness).toEqual({ canCommit: true, copyCount: 1 })
    })

    /** Editing is the other way out of a duplicate — it is not "skip or nothing". */
    it('редагування відмінності теж знімає DUPLICATE_ROW', async () => {
      const row = fullRow()
      const draft = await preview(app, cookie, [row, { ...row }])
      const fixed = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 2 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 2), cells: { isbn13: isbn() } },
      )

      expect(rowOf(fixed, 2).errors).toEqual([])
      expect(fixed.counts).toMatchObject({ invalid: 0, readyCreateChain: 2 })
    })

    it('RESTORE повертає пропущений рядок і його статус', async () => {
      const draft = await preview(app, cookie, [fullRow()])
      const skipped = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'SKIP', expectedRowVersion: versionOf(draft, 1) },
      )

      expect(skipped.readiness).toEqual({ canCommit: false, copyCount: 0 })

      const restored = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'RESTORE', expectedRowVersion: versionOf(skipped, 1) },
      )

      expect(rowOf(restored, 1).status).toBe('READY_CREATE_CHAIN')
      expect(restored.readiness).toEqual({ canCommit: true, copyCount: 1 })
    })

    /**
     * R6a: a file over 500 copies never becomes a draft — the parser rejects it.
     * The live count can still cross the cap afterwards, through an edit, and
     * then it is readiness that has to say "not yet", not a broken draft.
     */
    it('файл понад 500 копій не стає чернеткою', async () => {
      const rows = Array.from({ length: 26 }, () => ({ ...fullRow(), quantity: '20' }))
      const response = await request(app.getHttpServer())
        .post(importUrl('/preview'))
        .set('Cookie', cookie)
        .send({ contentBase64: toBase64(csvContent(rows)) })
        .expect(413)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.IMPORT_TOO_LARGE)
      expect(error.details).toEqual({
        limit: 'COPIES',
        max: LIBRARY_IMPORT_LIMITS.maxCopies,
        actual: 520,
      })
    })

    /**
     * The one way past the cap after parsing: a row whose quantity was invalid
     * counted for nothing at parse time (R6a — it is NOT silently read as 1),
     * and fixing it adds its copies to a file already at the limit.
     */
    it('редагування, яке переводить чернетку за 500 копій, блокує commit', async () => {
      const atCap = Array.from({ length: 25 }, () => ({ ...fullRow(), quantity: '20' }))
      const draft = await preview(app, cookie, [...atCap, { ...fullRow(), quantity: 'багато' }])

      expect(rowOf(draft, 26).status).toBe('INVALID')
      expect(draft.readiness).toEqual({ canCommit: false, copyCount: 500 })

      const overflowed = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 26 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 26), cells: { quantity: '20' } },
      )

      expect(overflowed.counts.invalid).toBe(0)
      expect(overflowed.readiness.copyCount).toBe(520)
      expect(overflowed.readiness.copyCount).toBeGreaterThan(LIBRARY_IMPORT_LIMITS.maxCopies)
      expect(overflowed.readiness.canCommit).toBe(false)
    })
  })

  describe('повтор після збою провайдера', () => {
    it('RETRY доганяє рядок, який не вдалося резолвити, і не чіпає решту', async () => {
      const failing = isbn()
      const stable = fullRow()

      fake.respondUnavailable(failing, 'PROVIDER_ERROR')

      const draft = await preview(app, cookie, [{ isbn13: failing, orig_lang: 'en' }, stable])

      expect(rowOf(draft, 1).errors[0]).toMatchObject({
        code: 'LOOKUP_UNAVAILABLE',
        retryable: true,
      })

      fake.clear()
      fake.respondWith(failing, {
        title: `Полагоджена ${marker()}`,
        authors: [`Автор ${marker()}`],
      })

      const retried = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'RETRY', expectedRowVersion: versionOf(draft, 1) },
      )

      expect(rowOf(retried, 1).status).toBe('READY_CREATE_CHAIN')
      expect(rowOf(retried, 2)).toEqual(rowOf(draft, 2))
      expect(retried.readiness.canCommit).toBe(true)
      // Only the retried ISBN went out again: row 2 was never in doubt.
      expect(fake.batches.flat()).toEqual([failing])
    })

    /**
     * A negative answer IS cached (the same contract the wizard uses), so a
     * retry of a genuinely unknown ISBN costs no second call — and still says
     * "not found" rather than pretending the search never happened.
     */
    it('RETRY рядка, якого провайдер не знає, не витрачає новий виклик', async () => {
      const unknown = isbn()

      fake.respondNotFound(unknown)

      const draft = await preview(app, cookie, [{ isbn13: unknown }])

      fake.clear()

      const retried = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'RETRY', expectedRowVersion: versionOf(draft, 1) },
      )

      expect(errorCodesOf(retried, 1)).toEqual(['LOOKUP_NOT_FOUND', 'MISSING_CATALOG_DATA'])
      expect(fake.batches).toEqual([])
    })

    it('жодна дія над рядком не створює доменних сутностей', async () => {
      const title = `Мальви ${marker()}`
      const author = `Шевчук ${marker()}`
      const workId = await createWork(title, author)
      const rowIsbn = isbn()

      fake.respondWith(rowIsbn, { title, authors: [author] })

      const draft = await preview(app, cookie, [{ isbn13: rowIsbn, orig_lang: 'en' }, fullRow()])
      const before = await domainCounts()
      const target = { importId: draft.import.id, rowNumber: 1 }

      // Each action hands over the version the PREVIOUS answer reported: an
      // explicit action on a row always mints a new one.
      const chosen = await patchRow(app, cookie, target, {
        action: 'CHOOSE',
        expectedRowVersion: versionOf(draft, 1),
        workId,
      })
      const skipped = await patchRow(app, cookie, target, {
        action: 'SKIP',
        expectedRowVersion: versionOf(chosen, 1),
      })
      const restored = await patchRow(app, cookie, target, {
        action: 'RESTORE',
        expectedRowVersion: versionOf(skipped, 1),
      })

      await patchRow(app, cookie, target, {
        action: 'RETRY',
        expectedRowVersion: versionOf(restored, 1),
      })
      await patchRow(
        app,
        cookie,
        { ...target, rowNumber: 2 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 2), cells: { quantity: '4' } },
      )

      expect(await domainCounts()).toEqual(before)
    })
  })

  describe('конкурентність', () => {
    /**
     * Two PATCHes on the same draft, released together. They are serialized on
     * the import row, so both land: the draft that comes back last describes
     * every change, never half of one.
     */
    it('дві одночасні зміни різних рядків обидві потрапляють у чернетку', async () => {
      const draft = await preview(app, cookie, [fullRow(), fullRow()])
      const target = (rowNumber: number): string =>
        importUrl(`/${draft.import.id}/rows/${String(rowNumber)}`)

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .patch(target(1))
          .set('Cookie', cookie)
          .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) }),
        request(app.getHttpServer())
          .patch(target(2))
          .set('Cookie', cookie)
          .send({
            action: 'EDIT',
            expectedRowVersion: versionOf(draft, 2),
            cells: { quantity: '5' },
          }),
      ])

      expect([first?.status, second?.status]).toEqual([200, 200])

      const final = await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', cookie)
        .expect(200)
      const body = final.body as LibraryImportDraftResponse

      expect(body.rows.find((row) => row.rowNumber === 1)?.status).toBe('SKIPPED')
      expect(body.rows.find((row) => row.rowNumber === 2)?.values?.quantity).toBe(5)
      expect(body.readiness).toEqual({ canCommit: true, copyCount: 5 })
    })

    /**
     * The serialization above is not an accident of timing — the PATCH really
     * takes the import row's lock. Held from the test side, the request blocks
     * in PostgreSQL (`pg_stat_activity.wait_event_type = 'Lock'`, checked for,
     * not slept through) and only completes once the lock is released.
     */
    it('PATCH чекає на блокування рядка імпорту, а не пише повз нього', async () => {
      const draft = await preview(app, cookie, [fullRow()])
      const release = deferred()
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "LibraryImport" WHERE "id" = ${draft.import.id} FOR UPDATE
          `
          await release.promise
        },
        { timeout: 20_000 },
      )

      const patch = beginRequest(
        request(app.getHttpServer())
          .patch(importUrl(`/${draft.import.id}/rows/1`))
          .set('Cookie', cookie)
          .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) }),
      )

      await waitForBlockedBackend(prisma)

      release.resolve()
      await holder

      const response = await patch

      expect(response.status).toBe(200)
      expect((response.body as LibraryImportDraftResponse).rows[0]?.status).toBe('SKIPPED')
    })

    /**
     * A PATCH that runs while the draft expires must not resurrect it: expiry
     * and the row write share one transaction and one lock.
     */
    it('PATCH по чернетці, яка щойно прострочилася, повертає IMPORT_EXPIRED', async () => {
      const draft = await preview(app, cookie, [fullRow()])

      await prisma.libraryImport.update({
        where: { id: draft.import.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      const response = await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', cookie)
        .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) })
        .expect(410)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.IMPORT_EXPIRED)
      expect(await prisma.libraryImportRow.count({ where: { importId: draft.import.id } })).toBe(0)
    })
  })
})
