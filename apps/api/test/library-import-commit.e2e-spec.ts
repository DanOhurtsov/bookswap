import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
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
import { AnalyticsService } from '../src/analytics/analytics.service'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { commit, commitRequest, patchRow, preview, versionOf } from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8g, §4: `POST /me/library/imports/:id/commit`.
 *
 * Every case asks one of two questions. Either: did exactly the reviewed books
 * appear, once, with the fields the file gave them? Or: when the answer was
 * "no", did the domain stay EXACTLY as it was — not a `Work`, not an `Author`,
 * not one `Copy`?
 *
 * The second question is why `domainCounts()` is taken before and after almost
 * every refusal below. A commit that half-lands is worse than one that fails:
 * there is no screen in the product from which a person could see it, let alone
 * undo it.
 */
describe('CSV import commit (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  let ownerId: string
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

  async function register(prefix: string): Promise<{ cookie: string; userId: string }> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Імпортер' })
      .expect(201)
    const body = response.body as { user: { id: string } }

    return { cookie: sessionCookie(response.headers), userId: body.user.id }
  }

  /**
   * A row that needs nothing from a provider: the file itself describes the
   * whole chain.
   *
   * Title AND author are unique per call, and that is not incidental tidiness.
   * Candidate search matches a work by either of them (R7a), and even ONE
   * similar work makes a row `NEEDS_REVIEW` — so a fixture reusing a name would
   * stop being ready as soon as an earlier test in this file, or an earlier run
   * against this shared database, had committed it.
   */
  function chainRow(
    overrides: Partial<LibraryImportCsvCells> = {},
  ): Partial<LibraryImportCsvCells> {
    const token = randomUUID()

    return {
      isbn13: uniqueIsbn13('library-import-commit'),
      title: `Твір ${token}`,
      authors: `Автор ${token}`,
      orig_lang: 'en',
      ...overrides,
    }
  }

  function expectError(response: request.Response, code: string, reason?: string) {
    const error = apiErrorSchema.parse(response.body)

    expect(error.code).toBe(code)

    if (reason !== undefined) expect(error.details).toMatchObject({ reason })

    return error
  }

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
      },
    })
    prisma = app.get(PrismaService)

    const owner = await register('commit-owner')

    cookie = owner.cookie
    ownerId = owner.userId
    strangerCookie = (await register('commit-stranger')).cookie
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  it('створює весь ланцюг каталогу й примірники за один коміт', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const title = `Ланцюг ${randomUUID()}`
    const draft = await preview(app, cookie, [
      chainRow({
        isbn13: isbn,
        title,
        authors: 'Перший Автор|Другий Автор',
        first_pub_year: '2003',
        publisher: 'Рідна мова',
        edition_year: '2016',
        page_count: '800',
        condition: 'WORN',
        visibility: 'PRIVATE',
        note: 'у коробці на балконі',
        acquired_at: '2024-05-01',
        quantity: '2',
      }),
    ])

    expect(draft.readiness.canCommit).toBe(true)
    expect(draft.readiness.blockers).toEqual([])

    const committed = await commit(app, cookie, draft)

    expect(committed.import.status).toBe('COMMITTED')
    expect(committed.import.createdCopyCount).toBe(2)
    expect(committed.import.committedAt).not.toBeNull()
    // R6: the payload is gone with the commit — the private note included.
    expect(committed.rows).toEqual([])

    const edition = await prisma.edition.findUnique({
      where: { isbn13: isbn },
      include: {
        work: { include: { authors: { include: { author: true }, orderBy: { position: 'asc' } } } },
        copies: true,
      },
    })

    expect(edition).not.toBeNull()
    expect(edition?.publisher).toBe('Рідна мова')
    expect(edition?.year).toBe(2016)
    expect(edition?.pageCount).toBe(800)
    expect(edition?.createdById).toBe(ownerId)
    // No translation: the edition language was never said to differ from the
    // work's original language, so this is the original (R4).
    expect(edition?.translationId).toBeNull()

    expect(edition?.work.title).toBe(title)
    expect(edition?.work.origLang).toBe('en')
    expect(edition?.work.firstPubYear).toBe(2003)
    expect(edition?.work.createdById).toBe(ownerId)
    // R10a: order is the order the file gave, and positions are gapless.
    expect(edition?.work.authors.map((link) => link.author.name)).toEqual([
      'Перший Автор',
      'Другий Автор',
    ])
    expect(edition?.work.authors.map((link) => link.position)).toEqual([0, 1])
    expect(edition?.work.authors.every((link) => link.role === 'AUTHOR')).toBe(true)

    expect(edition?.copies).toHaveLength(2)

    for (const copy of edition?.copies ?? []) {
      expect(copy.ownerId).toBe(ownerId)
      // §5.3.2: a copy is born at home.
      expect(copy.currentHolderId).toBe(ownerId)
      expect(copy.status).toBe('AVAILABLE')
      expect(copy.condition).toBe('WORN')
      expect(copy.visibility).toBe('PRIVATE')
      expect(copy.note).toBe('у коробці на балконі')
      expect(copy.acquiredAt?.toISOString()).toBe('2024-05-01T00:00:00.000Z')
    }
  })

  it('створює переклад один раз на ланцюг, а не на кожен примірник', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({
        isbn13: isbn,
        title: `Переклад ${randomUUID()}`,
        orig_lang: 'en',
        edition_lang: 'uk',
        translator: 'Володимир Перекладач',
        translation_source_lang: 'en',
        translation_year: '2016',
        quantity: '3',
      }),
    ])

    await commit(app, cookie, draft)

    const edition = await prisma.edition.findUnique({
      where: { isbn13: isbn },
      include: { translation: true, copies: true, work: true },
    })

    expect(edition?.copies).toHaveLength(3)
    expect(edition?.translation?.translator).toBe('Володимир Перекладач')
    expect(edition?.translation?.lang).toBe('uk')
    expect(edition?.translation?.sourceLang).toBe('en')
    expect(edition?.translation?.createdById).toBe(ownerId)
    // One translation for the chain, whatever the quantity.
    expect(await prisma.translation.count({ where: { workId: edition?.work.id ?? '' } })).toBe(1)
  })

  it('додає примірники до наявного видання, не чіпаючи його каталогових даних', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const seeded = await seedEdition(isbn, 'Видавництво з бази')

    const draft = await preview(app, cookie, [
      { isbn13: isbn, title: 'Назва з файла', publisher: 'Видавництво з файла', quantity: '2' },
    ])

    expect(draft.rows[0]?.status).toBe('READY_EXISTING_EDITION')

    await commit(app, cookie, draft)

    const edition = await prisma.edition.findUnique({
      where: { id: seeded.editionId },
      include: { work: true, copies: true },
    })

    expect(edition?.copies).toHaveLength(2)
    // R6c: reuse means reuse. The import adds copies; it does not rewrite the
    // catalog entry somebody else may have curated.
    expect(edition?.publisher).toBe('Видавництво з бази')
    expect(edition?.work.title).toBe(`Наявний твір ${isbn}`)
  })

  it('пропущені рядки не імпортуються', async () => {
    const kept = uniqueIsbn13('library-import-commit')
    const dropped = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: kept, title: `Лишається ${randomUUID()}`, quantity: '2' }),
      chainRow({ isbn13: dropped, title: `Пропускається ${randomUUID()}`, quantity: '5' }),
    ])
    const skipped = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 2 },
      { action: 'SKIP', expectedRowVersion: versionOf(draft, 2) },
    )

    expect(skipped.readiness.copyCount).toBe(2)

    const committed = await commit(app, cookie, skipped)

    expect(committed.import.createdCopyCount).toBe(2)
    expect(await prisma.edition.findUnique({ where: { isbn13: dropped } })).toBeNull()
    expect(await prisma.edition.findUnique({ where: { isbn13: kept } })).not.toBeNull()
  })

  it('чужий імпорт — 404 і жодного запису', async () => {
    const draft = await preview(app, cookie, [chainRow()])
    const before = await domainCounts()

    const response = await commitRequest(
      app,
      strangerCookie,
      draft.import.id,
      draft.draftVersion,
    ).expect(404)

    expectError(response, API_ERROR_CODES.NOT_FOUND)
    expect(await domainCounts()).toEqual(before)
  })

  it('прострочена чернетка — 410, і коміт нічого не створює', async () => {
    const draft = await preview(app, cookie, [chainRow()])

    await prisma.libraryImport.update({
      where: { id: draft.import.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, draft.draftVersion).expect(
      410,
    )

    expectError(response, API_ERROR_CODES.IMPORT_EXPIRED)
    expect(await domainCounts()).toEqual(before)
  })

  it('нерозвʼязані рядки блокують коміт і названі поіменно', async () => {
    const draft = await preview(app, cookie, [
      chainRow(),
      // No title and no author, and the provider knows nothing: the row cannot
      // describe a work, so it stays NEEDS_REVIEW.
      { isbn13: uniqueIsbn13('library-import-commit') },
    ])

    expect(draft.readiness.canCommit).toBe(false)
    expect(draft.readiness.blockers).toContainEqual({
      reason: 'ROWS_UNRESOLVED',
      rowNumbers: [2],
    })

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, draft.draftVersion).expect(
      409,
    )

    const error = expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'ROWS_UNRESOLVED')

    expect(error.details).toMatchObject({ rowNumbers: [2] })
    expect(await domainCounts()).toEqual(before)
  })

  it('усі рядки пропущено — коміт недоступний', async () => {
    const draft = await preview(app, cookie, [chainRow(), chainRow()])
    let current = draft

    for (const rowNumber of [1, 2]) {
      current = await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber },
        { action: 'SKIP', expectedRowVersion: versionOf(current, rowNumber) },
      )
    }

    expect(current.readiness.canCommit).toBe(false)
    expect(current.readiness.blockers).toContainEqual({ reason: 'NOTHING_TO_IMPORT' })

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, current.draftVersion).expect(
      409,
    )

    expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'NOTHING_TO_IMPORT')
    expect(await domainCounts()).toEqual(before)
  })

  it('ліміт 500 примірників перевіряється повторно перед комітом', async () => {
    // R7a's exact scenario: at parse time a row with an invalid `quantity`
    // counts for nothing, so the file passes the cap. Fixing that row afterwards
    // pushes the live count past it — and the honest answer is the real number,
    // not one clipped to the limit it just broke.
    const full = Array.from({ length: 25 }, () => chainRow({ quantity: '20' }))
    const draft = await preview(app, cookie, [...full, chainRow({ quantity: 'багато' })])

    expect(draft.import.copyCount).toBe(500)
    expect(draft.readiness.copyCount).toBe(500)
    expect(draft.rows[25]?.status).toBe('INVALID')

    const repaired = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 26 },
      { action: 'EDIT', expectedRowVersion: versionOf(draft, 26), cells: { quantity: '20' } },
    )

    expect(repaired.readiness.copyCount).toBe(520)
    expect(repaired.readiness.canCommit).toBe(false)

    const before = await domainCounts()
    const response = await commitRequest(
      app,
      cookie,
      draft.import.id,
      repaired.draftVersion,
    ).expect(413)
    const error = apiErrorSchema.parse(response.body)

    expect(error.code).toBe(API_ERROR_CODES.IMPORT_TOO_LARGE)
    expect(error.details).toMatchObject({
      limit: 'COPIES',
      max: LIBRARY_IMPORT_LIMITS.maxCopies,
      actual: 520,
    })
    expect(await domainCounts()).toEqual(before)
  })

  it('застарілий expectedDraftVersion — 409 DRAFT_CHANGED без записів', async () => {
    const draft = await preview(app, cookie, [chainRow(), chainRow()])
    const stale = draft.draftVersion

    // Somebody's other tab skips a row. The commit below was decided before that.
    const changed = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 2 },
      { action: 'SKIP', expectedRowVersion: versionOf(draft, 2) },
    )

    expect(changed.draftVersion).not.toBe(stale)

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, stale).expect(409)

    expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'DRAFT_CHANGED')
    expect(await domainCounts()).toEqual(before)

    // The fresh version still works: the refusal was about staleness, not about
    // the draft being unusable.
    await commit(app, cookie, changed)
  })

  it('повторний коміт повертає збережений результат — і зі старим токеном, і після TTL', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, title: `Повтор ${randomUUID()}`, quantity: '2' }),
    ])
    const first = await commit(app, cookie, draft)
    const copiesAfterFirst = await prisma.copy.count({ where: { ownerId } })

    // A retry after a lost response: the rows are gone, so the version the
    // client still holds is the one from before the commit — and the original
    // TTL may well have passed in the meantime. Both must still answer.
    await prisma.libraryImport.update({
      where: { id: draft.import.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const second = await commit(app, cookie, draft)

    expect(second.import.status).toBe('COMMITTED')
    expect(second.import.createdCopyCount).toBe(first.import.createdCopyCount)
    expect(second.import.committedAt).toBe(first.import.committedAt)
    expect(await prisma.copy.count({ where: { ownerId } })).toBe(copiesAfterFirst)

    // A third one with a version that never existed: still the same answer.
    const third = await commitRequest(app, cookie, draft.import.id, 'f'.repeat(64)).expect(200)

    expect((third.body as LibraryImportDraftResponse).import.createdCopyCount).toBe(
      first.import.createdCopyCount,
    )
    expect(await prisma.copy.count({ where: { ownerId } })).toBe(copiesAfterFirst)
  })

  it('однаковий новий ISBN із різними даними — конфлікт, нічого не створено', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, title: `Той самий ISBN ${randomUUID()}`, publisher: 'Перше' }),
      chainRow({ isbn13: isbn, title: `Той самий ISBN ${randomUUID()}`, publisher: 'Друге' }),
    ])

    expect(draft.readiness.canCommit).toBe(false)
    expect(draft.readiness.blockers).toContainEqual({
      reason: 'CONFLICTING_EDITION_ROWS',
      rowNumbers: [1, 2],
    })

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, draft.draftVersion).expect(
      409,
    )

    expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'CONFLICTING_EDITION_ROWS')
    expect(await domainCounts()).toEqual(before)
  })

  it('однаковий новий ISBN з однаковими даними — одне видання й сума quantity', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const shared = chainRow({ isbn13: isbn, title: `Спільний ISBN ${randomUUID()}` })
    const draft = await preview(app, cookie, [
      { ...shared, quantity: '2', condition: 'NEW', note: 'подарунок' },
      { ...shared, quantity: '1', condition: 'DAMAGED', note: 'залита кава' },
    ])

    expect(draft.readiness.canCommit).toBe(true)

    await commit(app, cookie, draft)

    const editions = await prisma.edition.findMany({
      where: { isbn13: isbn },
      include: { copies: true, work: true },
    })

    expect(editions).toHaveLength(1)
    expect(editions[0]?.copies).toHaveLength(3)
    // R6c: rows share the chain, never the copy fields.
    expect(editions[0]?.copies.filter((copy) => copy.condition === 'NEW')).toHaveLength(2)
    expect(editions[0]?.copies.filter((copy) => copy.condition === 'DAMAGED')).toHaveLength(1)
    expect(editions[0]?.copies.filter((copy) => copy.note === 'залита кава')).toHaveLength(1)
  })

  it('різні ISBN одного твору створюють окремі Work — за назвою не обʼєднуємо', async () => {
    const first = uniqueIsbn13('library-import-commit')
    const second = uniqueIsbn13('library-import-commit')
    const title = `Однакова назва ${first}`
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: first, title, authors: 'Той Самий Автор' }),
      chainRow({ isbn13: second, title, authors: 'Той Самий Автор' }),
    ])

    // Not a conflict: different ISBNs are different editions, and the agreed
    // rule is that they do NOT get merged into one work by title or author.
    expect(draft.readiness.canCommit).toBe(true)

    await commit(app, cookie, draft)

    const works = await prisma.work.findMany({
      where: { title },
      include: { authors: { include: { author: true } } },
    })

    expect(works).toHaveLength(2)
    expect(works[0]?.id).not.toBe(works[1]?.id)
    // Namesakes are never merged either (R10a): two works, two author rows.
    const authorIds = works.flatMap((work) => work.authors.map((link) => link.authorId))

    expect(new Set(authorIds).size).toBe(2)
  })

  it('обраний Work, який змержили після preview — WORK_MERGED без записів', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const title = `Кандидат ${isbn}`
    const existing = await seedWork(title)
    const draft = await preview(app, cookie, [chainRow({ isbn13: isbn, title })])

    // The existing work makes this ambiguous by design (R7a); the owner picks it.
    expect(draft.rows[0]?.status).toBe('NEEDS_REVIEW')

    const chosen = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'CHOOSE', expectedRowVersion: versionOf(draft, 1), workId: existing.workId },
    )

    expect(chosen.readiness.canCommit).toBe(true)

    const target = await seedWork(`Ціль мержу ${isbn}`)

    await prisma.work.update({
      where: { id: existing.workId },
      data: { mergedIntoId: target.workId },
    })

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, chosen.draftVersion).expect(
      409,
    )
    const error = expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'WORK_MERGED')

    expect(error.details).toMatchObject({ rowNumbers: [1] })
    expect(await domainCounts()).toEqual(before)
  })

  it('обраний Work іншою мовою оригіналу — WORK_LANG_MISMATCH без записів', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const title = `Мовний кандидат ${isbn}`
    const existing = await seedWork(title, 'de')
    const draft = await preview(app, cookie, [chainRow({ isbn13: isbn, title, orig_lang: 'en' })])
    const chosen = await patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'CHOOSE', expectedRowVersion: versionOf(draft, 1), workId: existing.workId },
    )

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, chosen.draftVersion).expect(
      409,
    )

    expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'WORK_LANG_MISMATCH')
    expect(await domainCounts()).toEqual(before)
  })

  it('видання з тим самим ISBN зʼявилося після preview — EDITION_APPEARED без записів', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, title: `Випереджене ${randomUUID()}` }),
    ])

    expect(draft.rows[0]?.status).toBe('READY_CREATE_CHAIN')

    // Somebody else adds this very ISBN in the meantime.
    await seedEdition(isbn, 'Хтось інший устиг')

    const before = await domainCounts()
    const response = await commitRequest(app, cookie, draft.import.id, draft.draftVersion).expect(
      409,
    )
    const error = expectError(response, API_ERROR_CODES.IMPORT_NOT_READY, 'EDITION_APPEARED')

    expect(error.details).toMatchObject({ rowNumbers: [1] })
    expect(await domainCounts()).toEqual(before)
  })

  it('коміт не звертається до жодного зовнішнього провайдера', async () => {
    const draft = await preview(app, cookie, [chainRow()])

    fake.batches.length = 0
    await commit(app, cookie, draft)

    expect(fake.batches).toEqual([])
  })

  it('на кожен створений Copy припадає рівно одна подія BOOK_ADDED/CSV', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, title: `Аналітика ${randomUUID()}`, quantity: '3' }),
    ])

    await commit(app, cookie, draft)

    const copies = await prisma.copy.findMany({
      where: { edition: { isbn13: isbn } },
      select: { id: true },
    })

    expect(copies).toHaveLength(3)

    const events = await prisma.productEvent.findMany({
      where: {
        dedupeKey: { in: copies.map((copy) => computeDedupeKey('BOOK_ADDED', copy.id, ownerId)) },
      },
      select: { type: true, properties: true, subjectUserId: true },
    })

    expect(events).toHaveLength(3)
    expect(events.every((event) => event.type === 'BOOK_ADDED')).toBe(true)
    expect(events.every((event) => event.subjectUserId === ownerId)).toBe(true)
    expect(events.map((event) => event.properties)).toEqual([
      { method: 'CSV' },
      { method: 'CSV' },
      { method: 'CSV' },
    ])
  })

  it('збій analytics не робить успішний імпорт помилкою', async () => {
    const isbn = uniqueIsbn13('library-import-commit')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, title: `Без аналітики ${randomUUID()}`, quantity: '2' }),
    ])
    const analytics = app.get(AnalyticsService)
    const record = jest
      .spyOn(analytics, 'record')
      .mockRejectedValue(new Error('analytics недоступна'))

    try {
      // 8a's contract is that `record()` never throws; this proves the commit
      // does not depend on that promise being kept. The books are already in
      // the database by the time analytics is even asked.
      const committed = await commit(app, cookie, draft)

      expect(committed.import.createdCopyCount).toBe(2)
    } finally {
      record.mockRestore()
    }

    expect(await prisma.copy.count({ where: { edition: { isbn13: isbn } } })).toBe(2)
  })

  /** A canonical work with no editions — something a row can be asked to join. */
  async function seedWork(title: string, origLang = 'en'): Promise<{ workId: string }> {
    const [titleNorm] = await prisma.$queryRaw<{ value: string }[]>`
      SELECT bookswap_norm(${title}) AS value
    `
    const work = await prisma.work.create({
      data: {
        title,
        titleNorm: titleNorm?.value ?? title.toLowerCase(),
        origLang,
        createdById: ownerId,
      },
      select: { id: true },
    })

    return { workId: work.id }
  }

  async function seedEdition(
    isbn13: string,
    publisher: string,
  ): Promise<{ editionId: string; workId: string }> {
    const { workId } = await seedWork(`Наявний твір ${isbn13}`)
    const edition = await prisma.edition.create({
      data: { workId, isbn13, publisher, createdById: ownerId },
      select: { id: true },
    })

    return { editionId: edition.id, workId }
  }
})
