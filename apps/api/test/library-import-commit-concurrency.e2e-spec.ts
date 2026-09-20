import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
} from '@bookswap/shared'
import { Test, type TestingModule } from '@nestjs/testing'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import type { RawQueryRunner } from '../src/catalog/search-text'
import { TextNormalizer } from '../src/catalog/text-normalizer'
import { MergeService } from '../src/catalog/merge/merge.service'
import { MergeCliModule } from '../src/cli/merge-cli.module'
import { LibraryImportWriter } from '../src/library/import/library-import.writer'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import {
  barrier,
  beginRequest,
  deferred,
  waitForBlockedBackend,
  type Barrier,
} from './concurrency.helpers'
import {
  commit,
  commitRequest,
  importUrl,
  patchRow,
  preview,
  versionOf,
} from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8g (R6c): what happens when two things reach the same import, or the
 * same ISBN, or the same `Work` at once.
 *
 * No `sleep` anywhere. Contention is staged by holding a real row lock from the
 * test's own transaction and waiting until Postgres itself reports a backend
 * blocked on a lock (`waitForBlockedBackend`) — so each case proves the race it
 * claims to, rather than hoping the timing worked out this run.
 */

/**
 * Parks a commit between its catalog precheck and its first insert.
 *
 * `LibraryImportWriter.write()` runs `assertCatalogUnchanged` (which takes the
 * `Work` locks and reads the editions), then `createChains`, whose FIRST action
 * is normalizing titles through this class. So overriding it gives a seam at
 * exactly the moment the races below need — with no production code bent to
 * suit a test, and no `sleep` guessing when that moment arrives.
 */
class GatedTextNormalizer extends TextNormalizer {
  /** Armed only around the race itself: a preview normalizes titles too. */
  static gate: Barrier | undefined

  override async normalizeMany(values: string[], client?: RawQueryRunner): Promise<string[]> {
    const normalized =
      client === undefined ? super.normalizeMany(values) : super.normalizeMany(values, client)
    const result = await normalized

    await GatedTextNormalizer.gate?.arrive()

    return result
  }
}

/**
 * Explicit, because these tests really do wait — on a row lock, on a barrier —
 * and `jest-e2e.json` says so: the file-wide 15 s is for ordinary scenarios,
 * and anything that waits carries its own budget instead of borrowing it.
 */
const LOCK_RACE_TIMEOUT_MS = 30_000

/** How long a deliberately held lock may take to be granted before the test gives up. */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000

/** How long the holding transaction may stay open — above every wait inside a test. */
const LOCK_HOLD_TIMEOUT_MS = 30_000

/** Named rather than a `Record`, so a per-table delta can be asserted directly. */
interface DomainCounts {
  work: number
  author: number
  workAuthor: number
  translation: number
  edition: number
  copy: number
}

/** Fails a commit AFTER every domain write has landed — the worst moment to fail. */
class ExplodingWriter extends LibraryImportWriter {
  static failAfterWrite = false

  override async write(context: Parameters<LibraryImportWriter['write']>[0]): Promise<string[]> {
    const copyIds = await super.write(context)

    if (ExplodingWriter.failAfterWrite) {
      throw new Error('інжектований збій після доменних записів')
    }

    return copyIds
  }
}

describe('CSV import commit concurrency (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string
  let ownerId: string
  let secondCookie: string
  /**
   * `MergeService` is not part of `AppModule` — merging is a v1 operator script
   * (`src/cli/merge-works.ts`), not an endpoint. The same separate context
   * `catalog-merge.e2e-spec.ts` uses is how a test reaches the real merge
   * instead of re-implementing it.
   */
  let mergeContext: TestingModule
  const fake = new FakeBatchLookupProvider()

  async function domainCounts(): Promise<DomainCounts> {
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
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Гонщик' })
      .expect(201)
    const body = response.body as { user: { id: string } }

    return { cookie: sessionCookie(response.headers), userId: body.user.id }
  }

  /** Unique title and author per row, so candidate search never makes a row ambiguous. */
  function chainRow(
    overrides: Partial<LibraryImportCsvCells> = {},
  ): Partial<LibraryImportCsvCells> {
    const token = randomUUID()

    return {
      isbn13: uniqueIsbn13('library-import-commit-concurrency'),
      title: `Твір ${token}`,
      authors: `Автор ${token}`,
      orig_lang: 'en',
      ...overrides,
    }
  }

  /**
   * A lock this test holds on purpose, so a concurrent operation has something
   * real to queue behind.
   *
   * `ready` is the part that matters. Starting the transaction says nothing
   * about when its `FOR UPDATE` actually returns, so a test that fired its
   * concurrent requests straight after would be racing the very setup meant to
   * make the race deterministic. Awaiting `ready` means the row IS locked.
   */
  interface HeldLock {
    /** Resolves only once the `FOR UPDATE` has returned. Bounded; never hangs. */
    ready: Promise<void>
    /** Safe to call more than once, and safe to call when nothing was acquired. */
    release: () => void
    /** The holding transaction, settled. Awaited in `finally`, so it never throws. */
    finished: Promise<void>
  }

  /**
   * Wraps a holding transaction into a {@link HeldLock}.
   *
   * Three ways this can go wrong, and all three end in a rejected `ready`
   * rather than a hang: the lock is never granted (bounded by a timer), the
   * transaction fails before acquiring, or it fails afterwards. A test that
   * cannot get its lock has to say so, not sit until Jest's own timeout and
   * report nothing about why.
   */
  function heldLock(
    what: string,
    acquired: Promise<void>,
    gate: () => void,
    running: Promise<unknown>,
  ): HeldLock {
    // Attached synchronously: `running` may reject before any test awaits it,
    // and an unhandled rejection would fail an unrelated later test.
    const finished = running.then(
      () => undefined,
      () => undefined,
    )
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Лок ${what} не захоплено за ${String(LOCK_ACQUIRE_TIMEOUT_MS)} мс — ` +
              'тест не довів, що конкурентна операція справді стала в чергу',
          ),
        )
      }, LOCK_ACQUIRE_TIMEOUT_MS)

      timer.unref()
      void acquired.then(() => {
        clearTimeout(timer)
        resolve()
      })
      void running.catch((error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })

    return { ready, release: gate, finished }
  }

  /**
   * Holds a row lock on the import until released.
   *
   * This is the pause a commit has no hook for: the operation blocks in
   * Postgres, where the test can observe it, instead of somewhere inside the
   * service where only a timer could approximate it.
   */
  function holdImportLock(importId: string): HeldLock {
    const acquired = deferred()
    const gate = deferred()
    const running = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "LibraryImport" WHERE "id" = ${importId} FOR UPDATE`
        acquired.resolve()
        await gate.promise
      },
      { timeout: LOCK_HOLD_TIMEOUT_MS },
    )

    return heldLock(`LibraryImport ${importId}`, acquired.promise, gate.resolve, running)
  }

  /**
   * Holds the `Work` row the way a merge does, and marks it merged inside that
   * same transaction.
   *
   * The update MUST run on `tx`. Writing it through `prisma` instead would open
   * a second connection that waits for the lock this very transaction is
   * holding — a deadlock with itself, and one that looks exactly like a slow
   * test until you go looking.
   */
  function holdMergedWorkLock(workId: string, mergedIntoId: string): HeldLock {
    const acquired = deferred()
    const gate = deferred()
    const running = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${workId} FOR UPDATE`
        await tx.work.update({ where: { id: workId }, data: { mergedIntoId } })
        acquired.resolve()
        await gate.promise
      },
      { timeout: LOCK_HOLD_TIMEOUT_MS },
    )

    return heldLock(`Work ${workId}`, acquired.promise, gate.resolve, running)
  }

  /**
   * Releases every gate and drains every request already in flight.
   *
   * Called from `finally`, so it must never throw and must never skip work
   * because an earlier step failed: an abandoned request would otherwise settle
   * during a LATER test, and a transaction left open would hold its row lock
   * until its own timeout, blocking whatever ran next.
   */
  async function drain(
    gates: readonly { release: () => void }[],
    inFlight: readonly Promise<unknown>[],
    locks: readonly HeldLock[] = [],
  ): Promise<void> {
    for (const gate of gates) gate.release()

    await Promise.allSettled(inFlight)
    await Promise.allSettled(locks.map((lock) => lock.finished))
  }

  async function seedWork(title: string, origLang = 'en'): Promise<string> {
    const [normalized] = await prisma.$queryRaw<{ value: string }[]>`
      SELECT bookswap_norm(${title}) AS value
    `
    const work = await prisma.work.create({
      data: {
        title,
        titleNorm: normalized?.value ?? title.toLowerCase(),
        origLang,
        createdById: ownerId,
      },
      select: { id: true },
    })

    return work.id
  }

  /** A draft whose single row will attach a new chain to an EXISTING work. */
  async function draftChoosing(workId: string, title: string): Promise<LibraryImportDraftResponse> {
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: uniqueIsbn13('library-import-commit-concurrency'), title }),
    ])

    return patchRow(
      app,
      cookie,
      { importId: draft.import.id, rowNumber: 1 },
      { action: 'CHOOSE', expectedRowVersion: versionOf(draft, 1), workId },
    )
  }

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
        builder.overrideProvider(LibraryImportWriter).useClass(ExplodingWriter)
        builder.overrideProvider(TextNormalizer).useClass(GatedTextNormalizer)
      },
    })
    prisma = app.get(PrismaService)

    const owner = await register('commit-race-owner')

    cookie = owner.cookie
    ownerId = owner.userId
    secondCookie = (await register('commit-race-second')).cookie
    mergeContext = await Test.createTestingModule({ imports: [MergeCliModule] }).compile()
  })

  afterEach(() => {
    fake.clear()
    ExplodingWriter.failAfterWrite = false
    GatedTextNormalizer.gate = undefined
  })

  afterAll(async () => {
    await mergeContext.close()
    await app.close()
  })

  it(
    'два одночасні коміти створюють рівно один комплект примірників',
    async () => {
      const isbn = uniqueIsbn13('library-import-commit-concurrency')
      const draft = await preview(app, cookie, [chainRow({ isbn13: isbn, quantity: '3' })])
      const lock = holdImportLock(draft.import.id)
      const inFlight: Promise<request.Response>[] = []

      try {
        // The row is provably locked before either request is sent; without this
        // the two commits could sail past a lock that was not taken yet.
        await lock.ready

        // Both requests are in flight and both are queued behind that same row
        // lock: a real race, not two sequential calls.
        inFlight.push(
          beginRequest(commitRequest(app, cookie, draft.import.id, draft.draftVersion)),
          beginRequest(commitRequest(app, cookie, draft.import.id, draft.draftVersion)),
        )

        await waitForBlockedBackend(prisma, { expectedCount: 2 })
        lock.release()
        await lock.finished

        const responses = await Promise.all(inFlight)

        for (const response of responses) {
          expect(response.status).toBe(200)

          const body = response.body as LibraryImportDraftResponse

          expect(body.import.status).toBe('COMMITTED')
          expect(body.import.createdCopyCount).toBe(3)
        }
      } finally {
        await drain([lock], inFlight, [lock])
      }

      expect(await prisma.copy.count({ where: { edition: { isbn13: isbn } } })).toBe(3)
      expect(await prisma.edition.count({ where: { isbn13: isbn } })).toBe(1)
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  it(
    'merge встигає першим — коміт відхилено, нічого не створено',
    async () => {
      // The row must be OFFERED this work before it can choose it (R7a), so the
      // seeded work and the file row carry the very same title.
      const title = `Ціль гонки ${randomUUID()}`
      const workId = await seedWork(title)
      const target = await seedWork(`Переможець мержу ${randomUUID()}`)
      const chosen = await draftChoosing(workId, title)

      expect(chosen.readiness.canCommit).toBe(true)

      // The merge holds the Work row and marks it merged; the commit queues behind
      // exactly that lock — the same one `MergeService.lockWorks` takes.
      const lock = holdMergedWorkLock(workId, target)
      const inFlight: Promise<request.Response>[] = []
      let before: DomainCounts | undefined

      try {
        await lock.ready
        before = await domainCounts()
        inFlight.push(
          beginRequest(commitRequest(app, cookie, chosen.import.id, chosen.draftVersion)),
        )

        await waitForBlockedBackend(prisma, { expectedCount: 1 })
        lock.release()
        await lock.finished

        const [response] = await Promise.all(inFlight)

        expect(response?.status).toBe(409)

        const error = apiErrorSchema.parse(response?.body)

        expect(error.code).toBe(API_ERROR_CODES.IMPORT_NOT_READY)
        expect(error.details).toMatchObject({ reason: 'WORK_MERGED', rowNumbers: [1] })
      } finally {
        await drain([lock], inFlight, [lock])
      }

      expect(await domainCounts()).toEqual(before)
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  it(
    'коміт встигає першим — merge чекає на його lock і переносить нове видання',
    async () => {
      const title = `Джерело мержу ${randomUUID()}`
      const sourceWorkId = await seedWork(title)
      const targetWorkId = await seedWork(`Ціль після коміту ${randomUUID()}`)
      const chosen = await draftChoosing(sourceWorkId, title)
      const gate = barrier(1)

      GatedTextNormalizer.gate = gate

      // The commit is parked mid-transaction, HOLDING the `Work` row lock it took
      // in `lockChosenWorks`. The merge started below therefore has to queue on
      // that very lock — the other order of the case above, and genuinely
      // overlapping rather than merely sequential.
      const pendingCommit = beginRequest(
        commitRequest(app, cookie, chosen.import.id, chosen.draftVersion),
      )
      // Declared out here so `finally` can drain it even when `gate.ready` or
      // `waitForBlockedBackend` throws before the merge is ever started.
      let pendingMerge: Promise<unknown> | undefined

      try {
        await gate.ready

        pendingMerge = mergeContext.get(MergeService).merge(sourceWorkId, targetWorkId)

        await waitForBlockedBackend(prisma, { expectedCount: 1 })

        gate.release()

        const response = await pendingCommit

        expect(response.status).toBe(200)

        await pendingMerge
      } finally {
        GatedTextNormalizer.gate = undefined
        await drain([gate], [pendingCommit, pendingMerge ?? Promise.resolve()])
      }

      const edition = await prisma.edition.findFirstOrThrow({
        where: { isbn13: { not: null }, copies: { some: { ownerId } } },
        orderBy: { createdAt: 'desc' },
        select: { workId: true, copies: { select: { id: true } }, translationId: true },
      })

      // The merge arrived second and carried the freshly imported edition with
      // everything else, rather than stranding it on a work nobody can reach
      // any more (§6.3).
      expect(edition.workId).toBe(targetWorkId)
      expect(edition.copies).toHaveLength(1)
      expect(await prisma.work.findUniqueOrThrow({ where: { id: sourceWorkId } })).toMatchObject({
        mergedIntoId: targetWorkId,
      })
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  it(
    'два різні імпорти на той самий новий ISBN: справжня unique-гонка, переможений відкочений цілком',
    async () => {
      const isbn = uniqueIsbn13('library-import-commit-concurrency')
      const mine = await preview(app, cookie, [chainRow({ isbn13: isbn, quantity: '2' })])
      const theirs = await preview(app, secondCookie, [chainRow({ isbn13: isbn, quantity: '5' })])
      const before = await domainCounts()
      // Both commits are held between their catalog precheck and their first
      // insert. That is the whole point: released together, BOTH have already
      // seen "no such ISBN", so the unique index is what decides — not one of
      // them reading the other's committed row and bowing out early.
      const gate = barrier(2)

      GatedTextNormalizer.gate = gate

      const first = beginRequest(commitRequest(app, cookie, mine.import.id, mine.draftVersion))
      const second = beginRequest(
        commitRequest(app, secondCookie, theirs.import.id, theirs.draftVersion),
      )

      const inFlight = [first, second]

      try {
        await gate.ready
      } finally {
        // Both requests are already out. Whether the barrier gathered them or
        // timed out waiting, they have to be let go and drained here: a commit
        // abandoned mid-transaction would hold its row locks into the next test.
        GatedTextNormalizer.gate = undefined
        await drain([gate], inFlight)
      }

      const [mineResponse, theirsResponse] = await Promise.all(inFlight)
      const statuses = [mineResponse?.status ?? 0, theirsResponse?.status ?? 0].sort(
        (left, right) => left - right,
      )

      expect(statuses).toEqual([200, 409])

      const winnerIsMine = mineResponse?.status === 200
      const loser = winnerIsMine ? theirsResponse : mineResponse
      const error = apiErrorSchema.parse(loser?.body)

      expect(error.code).toBe(API_ERROR_CODES.IMPORT_NOT_READY)
      expect(error.details).toMatchObject({ reason: 'EDITION_APPEARED' })

      const editions = await prisma.edition.findMany({
        where: { isbn13: isbn },
        include: { copies: true },
      })

      expect(editions).toHaveLength(1)
      expect(editions[0]?.copies).toHaveLength(winnerIsMine ? 2 : 5)

      // Every domain table, not just Edition and Copy: the loser wrote an Author,
      // a Work and its author link before the insert that failed, and all of them
      // must be gone. Exactly one import's worth of rows may have appeared.
      const after = await domainCounts()

      expect(after.work - before.work).toBe(1)
      expect(after.author - before.author).toBe(1)
      expect(after.workAuthor - before.workAuthor).toBe(1)
      expect(after.translation - before.translation).toBe(0)
      expect(after.edition - before.edition).toBe(1)
      expect(after.copy - before.copy).toBe(winnerIsMine ? 2 : 5)

      const loserImport = await prisma.libraryImport.findUniqueOrThrow({
        where: { id: (winnerIsMine ? theirs : mine).import.id },
        select: { status: true, createdCopyCount: true, rows: { select: { rowNumber: true } } },
      })

      expect(loserImport.status).toBe('DRAFT')
      expect(loserImport.createdCopyCount).toBeNull()
      // Its rows survived too, so the owner can simply retry that row.
      expect(loserImport.rows).toHaveLength(1)
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  /**
   * Both operations are in flight and both are queued on the import's row lock
   * before either can run. PostgreSQL grants a contended row lock in arrival
   * order, so starting them one at a time — and confirming each is actually
   * blocked before starting the next — fixes WHICH wins without ever making
   * them sequential: the loser is inside the server, waiting, the whole time.
   */
  async function queueOnImportLock(
    build: readonly (() => request.Test)[],
    /**
     * Filled in as requests go out, so the caller owns every one of them even
     * if this throws partway. Returning them instead would lose whatever was
     * already in flight the moment `waitForBlockedBackend` gave up — and those
     * requests would then settle during a later test.
     */
    pending: Promise<request.Response>[],
  ): Promise<void> {
    for (const [index, make] of build.entries()) {
      pending.push(beginRequest(make()))
      // One at a time, each confirmed blocked before the next is sent. Awaiting
      // in the loop is the point, not an oversight: it is what fixes the order
      // in which PostgreSQL will grant the lock.
      await waitForBlockedBackend(prisma, { expectedCount: index + 1 })
    }
  }

  it(
    'PATCH першим — застарілий коміт відхилено, хоча обидва вже були в польоті',
    async () => {
      const draft = await preview(app, cookie, [chainRow(), chainRow()])
      const stale = draft.draftVersion
      const lock = holdImportLock(draft.import.id)
      const inFlight: Promise<request.Response>[] = []
      let before: DomainCounts | undefined

      try {
        await lock.ready
        before = await domainCounts()

        await queueOnImportLock(
          [
            () =>
              request(app.getHttpServer())
                .patch(importUrl(`/${draft.import.id}/rows/2`))
                .set('Cookie', cookie)
                .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 2) }),
            () => commitRequest(app, cookie, draft.import.id, stale),
          ],
          inFlight,
        )

        lock.release()
        await lock.finished

        const [patch, pendingCommit] = await Promise.all(inFlight)

        expect(patch?.status).toBe(200)
        expect(pendingCommit?.status).toBe(409)
        expect(apiErrorSchema.parse(pendingCommit?.body).details).toMatchObject({
          reason: 'DRAFT_CHANGED',
        })
      } finally {
        await drain([lock], inFlight, [lock])
      }

      expect(await domainCounts()).toEqual(before)
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  it(
    'коміт першим — запізнілий PATCH нічого не змінює, хоча чекав поряд',
    async () => {
      const isbn = uniqueIsbn13('library-import-commit-concurrency')
      const draft = await preview(app, cookie, [chainRow({ isbn13: isbn, quantity: '2' })])
      const lock = holdImportLock(draft.import.id)
      const inFlight: Promise<request.Response>[] = []

      try {
        await lock.ready

        await queueOnImportLock(
          [
            () => commitRequest(app, cookie, draft.import.id, draft.draftVersion),
            () =>
              request(app.getHttpServer())
                .patch(importUrl(`/${draft.import.id}/rows/1`))
                .set('Cookie', cookie)
                .send({ action: 'SKIP', expectedRowVersion: versionOf(draft, 1) }),
          ],
          inFlight,
        )

        lock.release()
        await lock.finished

        const [pendingCommit, late] = await Promise.all(inFlight)

        expect(pendingCommit?.status).toBe(200)
        // The PATCH was waiting the whole time and still lands on a finished
        // import: it is refused, and the copies it would have prevented exist.
        expect(late?.status).toBe(409)
        expect(apiErrorSchema.parse(late?.body).code).toBe(API_ERROR_CODES.CONFLICT)
      } finally {
        await drain([lock], inFlight, [lock])
      }

      expect(await prisma.copy.count({ where: { edition: { isbn13: isbn } } })).toBe(2)

      const stored = await prisma.libraryImport.findUniqueOrThrow({
        where: { id: draft.import.id },
        select: { status: true, createdCopyCount: true },
      })

      expect(stored.status).toBe('COMMITTED')
      expect(stored.createdCopyCount).toBe(2)
    },
    LOCK_RACE_TIMEOUT_MS,
  )

  it('збій після всіх доменних записів не лишає нічого — ні Work, ні Copy', async () => {
    const isbn = uniqueIsbn13('library-import-commit-concurrency')
    const draft = await preview(app, cookie, [
      chainRow({ isbn13: isbn, authors: `Перший ${randomUUID()}|Другий ${randomUUID()}` }),
    ])
    const before = await domainCounts()

    ExplodingWriter.failAfterWrite = true

    await commitRequest(app, cookie, draft.import.id, draft.draftVersion).expect(500)

    // Every table, not just `Copy`: the author and the work were written before
    // the failure and must be gone with it.
    expect(await domainCounts()).toEqual(before)
    expect(await prisma.edition.findUnique({ where: { isbn13: isbn } })).toBeNull()

    const stored = await prisma.libraryImport.findUniqueOrThrow({
      where: { id: draft.import.id },
      select: { status: true, createdCopyCount: true, rows: { select: { rowNumber: true } } },
    })

    // The draft survives intact, so a retry is simply possible.
    expect(stored.status).toBe('DRAFT')
    expect(stored.createdCopyCount).toBeNull()
    expect(stored.rows).toHaveLength(1)

    ExplodingWriter.failAfterWrite = false

    const committed = await commit(app, cookie, draft)

    expect(committed.import.createdCopyCount).toBe(1)
  })
})
