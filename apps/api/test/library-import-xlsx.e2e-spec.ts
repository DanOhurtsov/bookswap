import 'reflect-metadata'
import { createHash } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import { Workbook } from 'exceljs'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_XLSX_HASH_PREFIX,
  LIBRARY_IMPORT_XLSX_LIMITS,
  libraryImportDraftResponseSchema,
  libraryImportInvalidXlsxDetailsSchema,
  type LibraryImportCsvCells,
} from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import {
  headerRow,
  xlsxDataRow,
  xlsxFile,
  xlsxWorkbook,
} from '../src/library/import/library-import-xlsx.test-helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import {
  csvContent,
  importUrl,
  preview,
  previewFile,
  rowOf,
  toBase64,
  versionOf,
} from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8f-4: `.xlsx` through the real preview endpoint.
 *
 * The question this file answers is not "does the reader work" — that is the
 * unit suite — but "does a workbook become the same import a CSV does". Every
 * guarantee 8f-2 gave (no domain writes, owner isolation, idempotency,
 * `rowVersion`) has to hold for a workbook without having been rebuilt for it.
 */
describe('XLSX library import preview (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  let strangerCookie: string
  const fake = new FakeBatchLookupProvider()

  async function domainCounts(): Promise<Record<string, number>> {
    const [work, author, translation, edition, copy] = await Promise.all([
      prisma.work.count(),
      prisma.author.count(),
      prisma.translation.count(),
      prisma.edition.count(),
      prisma.copy.count(),
    ])

    return { work, author, translation, edition, copy }
  }

  async function register(prefix: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Імпортер' })
      .expect(201)

    return sessionCookie(response.headers)
  }

  /** The stored hash of an import, to pin the hashing rule itself. */
  async function storedHash(importId: string): Promise<string> {
    const row = await prisma.libraryImport.findUniqueOrThrow({
      where: { id: importId },
      select: { sourceHash: true },
    })

    return row.sourceHash
  }

  async function rejects(
    file: { format: 'CSV' | 'XLSX'; bytes: Uint8Array },
    status: number,
  ): Promise<{ code: string; details: unknown }> {
    const response = await request(app.getHttpServer())
      .post(importUrl('/preview'))
      .set('Cookie', cookie)
      .send({ format: file.format, contentBase64: toBase64(file.bytes) })
      .expect(status)

    const body = apiErrorSchema.parse(response.body)

    return { code: body.code, details: body.details }
  }

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
      },
    })
    prisma = app.get(PrismaService)
    cookie = await register('xlsx-owner')
    strangerCookie = await register('xlsx-stranger')
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  const isbn = (): string => uniqueIsbn13('library-import-xlsx')

  /** The same books, spelled once as CSV cells and once as spreadsheet cells. */
  function bookCells(isbn13: string): Partial<LibraryImportCsvCells> {
    return { isbn13, title: 'Дюна', authors: 'Френк Герберт', quantity: '2' }
  }

  function workbookRowOf(cells: Partial<LibraryImportCsvCells>): string[] {
    return LIBRARY_IMPORT_CSV_HEADER.map((column) => cells[column] ?? '')
  }

  describe('a workbook is the same import a CSV is', () => {
    it('produces the same rows, counts and readiness as the equivalent CSV', async () => {
      const cells = bookCells(isbn())
      const fromCsv = await preview(app, cookie, [cells])
      const fromXlsx = await previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([workbookRowOf(cells)]),
      })

      expect(fromXlsx.rows.map((row) => row.cells)).toEqual(fromCsv.rows.map((row) => row.cells))
      expect(fromXlsx.rows.map((row) => row.values)).toEqual(fromCsv.rows.map((row) => row.values))
      expect(fromXlsx.rows.map((row) => row.status)).toEqual(fromCsv.rows.map((row) => row.status))
      expect(fromXlsx.counts).toEqual(fromCsv.counts)
      expect(fromXlsx.readiness).toEqual(fromCsv.readiness)
      // Two files, two imports: same books, but different cells to review and
      // different ways to fail (agreed 8f-4 hashing rule).
      expect(fromXlsx.import.id).not.toBe(fromCsv.import.id)
    })

    it('writes nothing to the catalog or the library', async () => {
      const before = await domainCounts()

      await previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([workbookRowOf(bookCells(isbn()))]),
      })

      expect(await domainCounts()).toEqual(before)
    })

    it('answers a repeated upload of the same workbook with the same draft', async () => {
      const bytes = await xlsxWorkbook([workbookRowOf(bookCells(isbn()))])
      const first = await previewFile(app, cookie, { format: 'XLSX', bytes })
      const again = await previewFile(app, cookie, { format: 'XLSX', bytes })

      expect(again.import.id).toBe(first.import.id)
      expect(again.rows.map((row) => row.rowVersion)).toEqual(
        first.rows.map((row) => row.rowVersion),
      )
    })

    it('keeps one owner’s workbook draft invisible to anyone else', async () => {
      const draft = await previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([workbookRowOf(bookCells(isbn()))]),
      })

      await request(app.getHttpServer())
        .get(importUrl(`/${draft.import.id}`))
        .set('Cookie', strangerCookie)
        .expect(404)
    })
  })

  describe('the hashing rule', () => {
    it('leaves the CSV hash exactly as 8f-1 computed it', async () => {
      // Pinned against the algorithm, not against itself: a prefix quietly
      // added to the CSV rule would orphan every draft saved before this
      // stage, and this is the assertion that would catch it.
      const cells = bookCells(isbn())
      const bytes = Buffer.from(csvContent([cells]), 'utf8')
      const draft = await preview(app, cookie, [cells])

      expect(await storedHash(draft.import.id)).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      )
    })

    it('hashes a workbook under the documented format prefix', async () => {
      const bytes = await xlsxWorkbook([workbookRowOf(bookCells(isbn()))])
      const draft = await previewFile(app, cookie, { format: 'XLSX', bytes })

      expect(await storedHash(draft.import.id)).toBe(
        createHash('sha256').update(LIBRARY_IMPORT_XLSX_HASH_PREFIX).update(bytes).digest('hex'),
      )
    })

    it('finds an existing CSV import again from a request that names CSV explicitly', async () => {
      const cells = bookCells(isbn())
      // Saved the old way — no `format` at all, as every 8f-2 client sends it.
      const original = await preview(app, cookie, [cells])
      const named = await previewFile(app, cookie, {
        format: 'CSV',
        bytes: Buffer.from(csvContent([cells]), 'utf8'),
      })

      expect(named.import.id).toBe(original.import.id)
    })
  })

  describe('a row of a workbook draft behaves like any other row', () => {
    it('refuses a stale action and accepts the current one', async () => {
      const draft = await previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([workbookRowOf(bookCells(isbn()))]),
      })
      const stale = versionOf(draft, 1)
      const target = importUrl(`/${draft.import.id}/rows/1`)

      const skipped = await request(app.getHttpServer())
        .patch(target)
        .set('Cookie', cookie)
        .send({ action: 'SKIP', expectedRowVersion: stale })
        .expect(200)

      expect(rowOf(skipped.body as never, 1).status).toBe('SKIPPED')

      const conflict = await request(app.getHttpServer())
        .patch(target)
        .set('Cookie', cookie)
        .send({ action: 'RESTORE', expectedRowVersion: stale })
        .expect(409)

      expect(apiErrorSchema.parse(conflict.body).code).toBe(API_ERROR_CODES.IMPORT_ROW_CONFLICT)
    })

    it('re-parses an edited cell through the same rules the workbook went through', async () => {
      const draft = await previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([workbookRowOf(bookCells(isbn()))]),
      })

      const edited = await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', cookie)
        .send({
          action: 'EDIT',
          expectedRowVersion: versionOf(draft, 1),
          cells: { quantity: 'три' },
        })
        .expect(200)

      expect(rowOf(edited.body as never, 1).errors.map((error) => error.code)).toEqual([
        'INVALID_FIELD',
      ])
    })
  })

  describe('a cell the reader refused survives every edit but its own', () => {
    async function draftWith(cells: Record<string, unknown>) {
      return previewFile(app, cookie, {
        format: 'XLSX',
        bytes: await xlsxWorkbook([xlsxDataRow({ isbn13: isbn(), ...cells })]),
      })
    }

    async function edit(
      draft: Awaited<ReturnType<typeof previewFile>>,
      patch: Record<string, string>,
    ) {
      const response = await request(app.getHttpServer())
        .patch(importUrl(`/${draft.import.id}/rows/1`))
        .set('Cookie', cookie)
        .send({ action: 'EDIT', expectedRowVersion: versionOf(draft, 1), cells: patch })
        .expect(200)

      return libraryImportDraftResponseSchema.parse(response.body)
    }

    /**
     * The bug this covers: the refused cell is stored empty, an empty
     * `quantity` means 1, and re-parsing the row on any edit would therefore
     * hand back a valid row — the column's default quietly standing in for a
     * value the file never carried.
     */
    it('keeps a refused quantity invalid when only the note is edited', async () => {
      const draft = await draftWith({ quantity: new Date(Date.UTC(2024, 4, 1)) })

      expect(rowOf(draft, 1).errors).toEqual([{ code: 'INVALID_FIELD', field: 'quantity' }])
      expect(rowOf(draft, 1).values).toBeNull()

      const edited = await edit(draft, { note: 'Моя нотатка' })

      expect(rowOf(edited, 1).errors).toEqual([{ code: 'INVALID_FIELD', field: 'quantity' }])
      expect(rowOf(edited, 1).values).toBeNull()
      expect(rowOf(edited, 1).status).toBe('INVALID')
      expect(rowOf(edited, 1).cells.note).toBe('Моя нотатка')
      expect(rowOf(edited, 1).rejectedCells).toEqual({ quantity: 'UNEXPECTED_DATE' })
      expect(edited.readiness.canCommit).toBe(false)
    })

    it('keeps a refused optional column invalid when another column is edited', async () => {
      const draft = await draftWith({ page_count: new Date(Date.UTC(2024, 4, 1)) })

      expect(rowOf(draft, 1).errors).toEqual([{ code: 'INVALID_FIELD', field: 'page_count' }])

      const edited = await edit(draft, { publisher: 'Видавництво' })

      expect(rowOf(edited, 1).errors).toEqual([{ code: 'INVALID_FIELD', field: 'page_count' }])
      expect(rowOf(edited, 1).rejectedCells).toEqual({ page_count: 'UNEXPECTED_DATE' })
    })

    it('clears the refusal only when that very column is corrected', async () => {
      const draft = await draftWith({ quantity: new Date(Date.UTC(2024, 4, 1)) })
      const edited = await edit(draft, { quantity: '2' })

      // Whatever catalog resolution then makes of the row is a separate
      // question; what matters here is that the field error and the rejection
      // that produced it are both gone, and the corrected value is in place.
      expect(rowOf(edited, 1).errors.map((error) => error.code)).not.toContain('INVALID_FIELD')
      expect(rowOf(edited, 1).rejectedCells).toEqual({})
      expect(rowOf(edited, 1).values?.quantity).toBe(2)
    })

    it('survives a skip and a restore, which change no cell at all', async () => {
      const draft = await draftWith({ quantity: new Date(Date.UTC(2024, 4, 1)) })
      const target = importUrl(`/${draft.import.id}/rows/1`)

      const skipped = await request(app.getHttpServer())
        .patch(target)
        .set('Cookie', cookie)
        .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) })
        .expect(200)
      const afterSkip = libraryImportDraftResponseSchema.parse(skipped.body)

      const restored = await request(app.getHttpServer())
        .patch(target)
        .set('Cookie', cookie)
        .send({ action: 'RESTORE', expectedRowVersion: versionOf(afterSkip, 1) })
        .expect(200)
      const afterRestore = libraryImportDraftResponseSchema.parse(restored.body)

      expect(rowOf(afterRestore, 1).errors).toEqual([{ code: 'INVALID_FIELD', field: 'quantity' }])
      expect(rowOf(afterRestore, 1).rejectedCells).toEqual({ quantity: 'UNEXPECTED_DATE' })
    })
  })

  describe('files the endpoint refuses', () => {
    it('refuses a formula and names the cell', async () => {
      const workbook = new Workbook()
      const sheet = workbook.addWorksheet('Sheet1')

      sheet.addRow(headerRow())
      sheet.addRow(xlsxDataRow({ isbn13: isbn() }))
      sheet.getCell('B2').value = { formula: 'A2&""', result: 'Обчислено' }

      const failure = await rejects(
        { format: 'XLSX', bytes: new Uint8Array(await workbook.xlsx.writeBuffer()) },
        400,
      )

      expect(failure.code).toBe(API_ERROR_CODES.IMPORT_INVALID_XLSX)
      expect(libraryImportInvalidXlsxDetailsSchema.parse(failure.details)).toEqual({
        reason: 'FORMULA_CELL',
        sheet: 1,
        row: 2,
        column: 2,
      })
    })

    it('asks for one data sheet instead of picking one', async () => {
      const bytes = await xlsxFile([
        { rows: [headerRow(), xlsxDataRow({ isbn13: isbn() })] },
        { rows: [headerRow(), xlsxDataRow({ isbn13: isbn() })] },
      ])
      const failure = await rejects({ format: 'XLSX', bytes }, 400)

      expect(failure.details).toEqual({ reason: 'MULTIPLE_SHEETS', sheets: [1, 2] })
    })

    it('refuses a legacy .xls or password-protected file with one honest reason', async () => {
      const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
      const failure = await rejects({ format: 'XLSX', bytes: cfb }, 400)

      expect(failure.details).toEqual({ reason: 'UNSUPPORTED_CONTAINER' })
    })

    it('refuses a CSV sent as a workbook rather than guessing the format', async () => {
      const bytes = Buffer.from(csvContent([bookCells(isbn())]), 'utf8')
      const failure = await rejects({ format: 'XLSX', bytes }, 400)

      expect(failure.details).toEqual({ reason: 'NOT_A_ZIP' })
    })

    it('refuses a workbook past the byte cap with its real size', async () => {
      const bytes = new Uint8Array(LIBRARY_IMPORT_XLSX_LIMITS.maxBytes + 1)
      const failure = await rejects({ format: 'XLSX', bytes }, 413)

      expect(failure.code).toBe(API_ERROR_CODES.IMPORT_TOO_LARGE)
      expect(failure.details).toEqual({
        limit: 'BYTES',
        max: LIBRARY_IMPORT_XLSX_LIMITS.maxBytes,
        actual: bytes.byteLength,
      })
    })

    it.each([null, '', 'XLS', 'csv'])('refuses the format value %j', async (format) => {
      const response = await request(app.getHttpServer())
        .post(importUrl('/preview'))
        .set('Cookie', cookie)
        .send({ format, contentBase64: toBase64('isbn13\n') })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('never echoes file content in a refusal', async () => {
      const header = headerRow()

      header[1] = 'моя власна назва колонки'

      const bytes = await xlsxFile([{ rows: [header, xlsxDataRow({ isbn13: isbn() })] }])
      const failure = await rejects({ format: 'XLSX', bytes }, 400)

      expect(JSON.stringify(failure)).not.toContain('моя власна назва колонки')
      expect(failure.details).toMatchObject({ reason: 'HEADER_MISMATCH', sheet: 1 })
    })
  })
})
