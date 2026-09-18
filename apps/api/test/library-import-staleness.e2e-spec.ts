import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  libraryImportDraftResponseSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
} from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { beginRequest } from './concurrency.helpers'
import { importUrl, patchRow, preview, rowOf, versionOf } from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8f-2, agreed concurrency contract: an operation applies only to the row
 * state it was decided on.
 *
 * Every race here is driven by explicit signals — the provider says when it has
 * been reached, the test says when it may answer. Nothing sleeps, so nothing
 * passes by being lucky with timing.
 *
 * Before `expectedRowVersion` existed, the first case below silently undid a
 * skip: the lock made the two operations take turns, and the late one still
 * applied itself to a row it had never seen.
 */
describe('CSV import: застарілі операції (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  const fake = new FakeBatchLookupProvider()

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
      },
    })
    prisma = app.get(PrismaService)

    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({
        email: uniqueEmail('import-stale'),
        password: VALID_PASSWORD,
        displayName: 'Гонщик',
      })
      .expect(201)

    cookie = sessionCookie(response.headers)
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  const isbn = (): string => uniqueIsbn13('library-import-staleness')

  let markers = 0

  const marker = (): string => {
    markers += 1

    return `${Math.random().toString(36).slice(2, 8)}${markers.toString(36)}`
  }

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

  /**
   * A row whose lookup failed: nothing is cached for it, so the next action on
   * it really does reach the provider — which is what lets a test park it there.
   */
  async function draftAwaitingRetry(
    rowIsbn: string,
    extra: readonly Partial<LibraryImportCsvCells>[] = [],
  ): Promise<LibraryImportDraftResponse> {
    fake.respondUnavailable(rowIsbn, 'PROVIDER_ERROR')

    const draft = await preview(app, cookie, [{ isbn13: rowIsbn, orig_lang: 'en' }, ...extra])

    expect(rowOf(draft, 1).errors[0]).toMatchObject({ code: 'LOOKUP_UNAVAILABLE' })

    return draft
  }

  function patch(importId: string, rowNumber: number, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .patch(importUrl(`/${importId}/rows/${String(rowNumber)}`))
      .set('Cookie', cookie)
      .send(body)
  }

  async function currentDraft(importId: string): Promise<LibraryImportDraftResponse> {
    const response = await request(app.getHttpServer())
      .get(importUrl(`/${importId}`))
      .set('Cookie', cookie)
      .expect(200)

    return libraryImportDraftResponseSchema.parse(response.body)
  }

  it('затриманий RETRY не скасовує SKIP, що завершився після нього', async () => {
    const rowIsbn = isbn()
    const draft = await draftAwaitingRetry(rowIsbn)
    const gate = fake.hold(rowIsbn)

    const retry = beginRequest(
      patch(draft.import.id, 1, { action: 'RETRY', expectedRowVersion: versionOf(draft, 1) }),
    )

    // The retry is inside the provider — said by the provider, not assumed.
    await gate.entered

    fake.respondWith(rowIsbn, { title: `Полагоджена ${marker()}`, authors: ['Автор'] })

    const skipped = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'SKIP', expectedRowVersion: versionOf(draft, 1) },
    )

    expect(rowOf(skipped, 1).status).toBe('SKIPPED')

    gate.release()

    const response = await retry

    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.IMPORT_ROW_CONFLICT)

    // The skip stands, and the retry wrote nothing at all.
    const after = await currentDraft(draft.import.id)

    expect(rowOf(after, 1).status).toBe('SKIPPED')
    expect(rowOf(after, 1).rowVersion).toBe(versionOf(skipped, 1))
  })

  it('затриманий EDIT не перезаписує новіший EDIT того самого рядка', async () => {
    const rowIsbn = isbn()
    const draft = await draftAwaitingRetry(rowIsbn)
    const gate = fake.hold(rowIsbn)

    const stale = beginRequest(
      patch(draft.import.id, 1, {
        action: 'EDIT',
        expectedRowVersion: versionOf(draft, 1),
        cells: { title: 'Стара назва' },
      }),
    )

    await gate.entered

    const newer = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      {
        action: 'EDIT',
        expectedRowVersion: versionOf(draft, 1),
        cells: { title: 'Новіша назва' },
      },
    )

    expect(rowOf(newer, 1).values?.title).toBe('Новіша назва')

    gate.release()

    const response = await stale

    expect(response.status).toBe(409)

    const after = await currentDraft(draft.import.id)

    expect(rowOf(after, 1).values?.title).toBe('Новіша назва')
  })

  /**
   * The reason a version is an opaque token and not a hash of the row: after
   * A → B → A the content is what it was, and an operation that read the first
   * A would otherwise be allowed to land on a row that has moved twice since.
   */
  it('A → B → A все одно конфліктує з операцією, що читала перше A', async () => {
    const draft = await preview(app, cookie, [fullRow({ title: 'A' })])
    const atFirstA = versionOf(draft, 1)

    const toB = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'EDIT', expectedRowVersion: atFirstA, cells: { title: 'B' } },
    )
    const backToA = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'EDIT', expectedRowVersion: versionOf(toB, 1), cells: { title: 'A' } },
    )

    expect(rowOf(backToA, 1).values?.title).toBe('A')
    expect(versionOf(backToA, 1)).not.toBe(atFirstA)

    const response = await patch(draft.import.id, 1, {
      action: 'SKIP',
      expectedRowVersion: atFirstA,
    }).expect(409)

    expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.IMPORT_ROW_CONFLICT)
  })

  /**
   * A revived draft is a new draft even when the file is byte-identical: the
   * old one expired, and an operation decided on it does not belong here.
   */
  it('операція, прочитана до expiry, не застосовується до відновленої чернетки', async () => {
    const rows = [fullRow()]
    const draft = await preview(app, cookie, rows)
    const staleVersion = versionOf(draft, 1)

    await prisma.libraryImport.update({
      where: { id: draft.import.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const revived = await preview(app, cookie, rows)

    expect(revived.import.id).toBe(draft.import.id)
    expect(rowOf(revived, 1).cells).toEqual(rowOf(draft, 1).cells)
    expect(versionOf(revived, 1)).not.toBe(staleVersion)

    const response = await patch(draft.import.id, 1, {
      action: 'SKIP',
      expectedRowVersion: staleVersion,
    }).expect(409)

    expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.IMPORT_ROW_CONFLICT)
    expect(rowOf(await currentDraft(draft.import.id), 1).status).not.toBe('SKIPPED')
  })

  /**
   * The flip side of the contract: only the row an action touched changes
   * version, so the technical rewrite of every row does not turn independent
   * work into a conflict.
   */
  it('зміна одного рядка не робить застарілою операцію над іншим', async () => {
    const draft = await preview(app, cookie, [fullRow(), fullRow()])

    const first = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'SKIP', expectedRowVersion: versionOf(draft, 1) },
    )

    // Row 2 kept its version through row 1's write, so a version read before
    // that write is still the current one.
    expect(versionOf(first, 2)).toBe(versionOf(draft, 2))

    const second = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 2 },
      { action: 'EDIT', expectedRowVersion: versionOf(draft, 2), cells: { quantity: '5' } },
    )

    expect(rowOf(second, 1).status).toBe('SKIPPED')
    expect(rowOf(second, 2).values?.quantity).toBe(5)
  })

  it('застаріла операція не витрачає зовнішнього виклику', async () => {
    const rowIsbn = isbn()
    const draft = await draftAwaitingRetry(rowIsbn)
    const skipped = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'SKIP', expectedRowVersion: versionOf(draft, 1) },
    )

    fake.clear()

    await patch(draft.import.id, 1, {
      action: 'RETRY',
      expectedRowVersion: versionOf(draft, 1),
    }).expect(409)

    expect(fake.batches).toEqual([])
    expect(rowOf(await currentDraft(draft.import.id), 1).rowVersion).toBe(versionOf(skipped, 1))
  })
})
