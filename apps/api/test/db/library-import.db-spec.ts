import { ConfigService } from '@nestjs/config'
import { Client } from 'pg'
import type { LibraryImportRowRecord } from '@bookswap/shared'
import { isUniqueViolationOn } from '../../src/common/prisma-errors'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { parseLibraryImportCsv } from '../../src/library/import/library-import-csv.parser'
import { csvFile, dataRow } from '../../src/library/import/library-import-csv.test-helpers'
import { LibraryImportPayloadError } from '../../src/library/import/library-import.errors'
import {
  LibraryImportRepository,
  type SaveLibraryImportDraftInput,
} from '../../src/library/import/library-import.repository'
import { PrismaService } from '../../src/prisma/prisma.service'
import { waitForBlockedBackend } from '../concurrency.helpers'
import { createGraph, createUser } from './fixtures'
import { createTestPrismaClient, testDatabaseUrl, truncateAll } from './test-database'

/**
 * Stage 8f-1 (docs/plan/stage-8-inventory.md, R6, §5): `LibraryImport` /
 * `LibraryImportRow` persistence against real PostgreSQL — owner isolation,
 * the `(ownerId, sourceHash)` key, lazy 24 h expiry, payload validation on
 * write and read, and zero domain writes.
 */

const HOUR_MS = 60 * 60 * 1000
const T0 = new Date('2026-09-17T10:00:00.000Z')
const TTL_END = new Date(T0.getTime() + 24 * HOUR_MS)
const SECRET_NOTE = 'PRIVATE-NOTE-db-5c1e'
const OWNER_SOURCE_HASH_UNIQUE = 'LibraryImport_ownerId_sourceHash_key'

function newPrismaService(): PrismaService {
  // `use-test-database.ts` already points DATABASE_URL at the guarded test database.
  return new PrismaService(new ConfigService())
}

interface ParsedDraft {
  sourceHash: string
  copyCount: number
  rows: LibraryImportRowRecord[]
}

/** Rows as a caller would persist them: parse-level errors → INVALID, the rest await resolution. */
function draftFrom(cells: Parameters<typeof dataRow>[0][]): ParsedDraft {
  const result = parseLibraryImportCsv(csvFile(cells.map((row) => dataRow(row))))

  if (!result.ok) throw new Error(`Fixture CSV did not parse: ${JSON.stringify(result.error)}`)

  return {
    sourceHash: result.sourceHash,
    copyCount: result.copyCount,
    rows: result.rows.map((row) => ({
      rowNumber: row.rowNumber,
      status: row.payload.errors.length > 0 ? 'INVALID' : 'NEEDS_REVIEW',
      // 8f-2: a stored row always carries its own opaque version.
      payload: { ...row.payload, rowVersion: `v-${String(row.rowNumber)}` },
    })),
  }
}

const FILE_A = draftFrom([
  { title: 'Кобзар', note: SECRET_NOTE, quantity: '2' },
  { isbn13: 'broken' },
  { title: 'Кобзар', note: SECRET_NOTE },
])
const FILE_B = draftFrom([{ title: 'Лісова пісня', condition: 'WORN' }])

function input(ownerId: string, file: ParsedDraft, now: Date): SaveLibraryImportDraftInput {
  return { ownerId, now, ...file }
}

async function domainCounts(prisma: PrismaClient): Promise<Record<string, number>> {
  return {
    work: await prisma.work.count(),
    author: await prisma.author.count(),
    workAuthor: await prisma.workAuthor.count(),
    translation: await prisma.translation.count(),
    edition: await prisma.edition.count(),
    copy: await prisma.copy.count(),
    loan: await prisma.loan.count(),
    productEvent: await prisma.productEvent.count(),
    catalogRevision: await prisma.catalogRevision.count(),
  }
}

describe('LibraryImport persistence (Stage 8f-1)', () => {
  let prisma: PrismaClient
  let service: PrismaService
  let repository: LibraryImportRepository

  beforeAll(() => {
    prisma = createTestPrismaClient()
    service = newPrismaService()
    repository = new LibraryImportRepository(service)
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  afterAll(async () => {
    await service.$disconnect()
    await prisma.$disconnect()
  })

  describe('schema objects', () => {
    it('has the owner/hash unique index, owner/status and expiresAt indexes', async () => {
      const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('LibraryImport', 'LibraryImportRow') ORDER BY indexname
      `
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]))

      expect(byName.get(OWNER_SOURCE_HASH_UNIQUE)).toMatch(
        /CREATE UNIQUE INDEX .*\("ownerId", "sourceHash"\)/,
      )
      expect(byName.get('LibraryImport_ownerId_status_idx')).toMatch(/\("ownerId", status\)/)
      expect(byName.get('LibraryImport_expiresAt_idx')).toMatch(/\("expiresAt"\)/)
      expect(byName.get('LibraryImportRow_pkey')).toMatch(/\("importId", "rowNumber"\)/)
    })

    it('cascades User → LibraryImport → LibraryImportRow on delete', async () => {
      const definitions = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid IN ('"LibraryImport"'::regclass, '"LibraryImportRow"'::regclass)
          AND contype = 'f'
        ORDER BY conname
      `

      expect(definitions).toEqual([
        {
          conname: 'LibraryImportRow_importId_fkey',
          definition: expect.stringMatching(
            /REFERENCES "LibraryImport"\(id\) ON UPDATE CASCADE ON DELETE CASCADE/,
          ) as unknown,
        },
        {
          conname: 'LibraryImport_ownerId_fkey',
          definition: expect.stringMatching(
            /REFERENCES "User"\(id\) ON UPDATE CASCADE ON DELETE CASCADE/,
          ) as unknown,
        },
      ])

      const ownerId = await createUser(prisma)
      await repository.saveDraft(input(ownerId, FILE_A, T0))
      await prisma.user.delete({ where: { id: ownerId } })

      expect(await prisma.libraryImport.count()).toBe(0)
      expect(await prisma.libraryImportRow.count()).toBe(0)
    })

    it('enforces commit-field, count, hash and row-number CHECK constraints', async () => {
      const ownerId = await createUser(prisma)
      const base = {
        ownerId,
        sourceHash: FILE_A.sourceHash,
        rowCount: 1,
        copyCount: 1,
        expiresAt: TTL_END,
      }

      await expect(
        prisma.libraryImport.create({ data: { ...base, status: 'COMMITTED' } }),
      ).rejects.toThrow(/library_import_commit_fields_match_status/)
      await expect(
        prisma.libraryImport.create({ data: { ...base, committedAt: T0 } }),
      ).rejects.toThrow(/library_import_commit_fields_match_status/)
      await expect(
        prisma.libraryImport.create({ data: { ...base, createdCopyCount: 1 } }),
      ).rejects.toThrow(/library_import_commit_fields_match_status/)
      await expect(
        prisma.libraryImport.create({ data: { ...base, copyCount: -1 } }),
      ).rejects.toThrow(/library_import_counts_nonnegative/)
      await expect(
        prisma.libraryImport.create({ data: { ...base, sourceHash: 'raw,csv,content' } }),
      ).rejects.toThrow(/library_import_source_hash_sha256/)

      const created = await prisma.libraryImport.create({ data: base })

      await expect(
        prisma.libraryImportRow.create({
          data: { importId: created.id, rowNumber: 0, status: 'SKIPPED', payload: {} },
        }),
      ).rejects.toThrow(/library_import_row_number_positive/)
    })
  })

  describe('(ownerId, sourceHash)', () => {
    it('rejects a second import of the same hash for one owner at the database level', async () => {
      const ownerId = await createUser(prisma)
      const data = {
        ownerId,
        sourceHash: FILE_A.sourceHash,
        rowCount: 1,
        copyCount: 1,
        expiresAt: TTL_END,
      }

      await prisma.libraryImport.create({ data })

      const error: unknown = await prisma.libraryImport
        .create({ data })
        .catch((caught: unknown) => caught)

      // Pins the exact constraint name the repository's retry recognizes.
      expect(isUniqueViolationOn(error, OWNER_SOURCE_HASH_UNIQUE)).toBe(true)
    })

    it('lets two owners hold the same hash independently', async () => {
      const ownerA = await createUser(prisma)
      const ownerB = await createUser(prisma)

      const a = await repository.saveDraft(input(ownerA, FILE_A, T0))
      const b = await repository.saveDraft(input(ownerB, FILE_A, T0))

      expect([a.outcome, b.outcome]).toEqual(['CREATED', 'CREATED'])
      expect(a.import.id).not.toBe(b.import.id)
      expect(await prisma.libraryImportRow.count()).toBe(FILE_A.rows.length * 2)
    })
  })

  describe('saveDraft and findOwned', () => {
    it('creates a draft with a 24 h TTL and stores exactly the validated rows, not the file', async () => {
      const ownerId = await createUser(prisma)
      const saved = await repository.saveDraft(input(ownerId, FILE_A, T0))

      expect(saved.outcome).toBe('CREATED')
      expect(saved.import).toMatchObject({
        ownerId,
        sourceHash: FILE_A.sourceHash,
        status: 'DRAFT',
        rowCount: 3,
        copyCount: 4,
        createdCopyCount: null,
        committedAt: null,
        expiresAt: TTL_END,
      })

      const owned = await repository.findOwned({ ownerId, importId: saved.import.id, now: T0 })

      expect(owned?.rows).toEqual(FILE_A.rows)
      expect(owned?.rows.map((row) => row.status)).toEqual(['NEEDS_REVIEW', 'INVALID', 'INVALID'])
    })

    it('returns an existing live draft untouched', async () => {
      const ownerId = await createUser(prisma)
      const first = await repository.saveDraft(input(ownerId, FILE_A, T0))
      const differentRows = { ...FILE_A, rows: FILE_B.rows, copyCount: 1 }
      const second = await repository.saveDraft({
        ownerId,
        now: new Date(T0.getTime() + HOUR_MS),
        ...differentRows,
      })

      expect(second.outcome).toBe('EXISTING_DRAFT')
      expect(second.import).toEqual(first.import)

      const owned = await repository.findOwned({ ownerId, importId: first.import.id, now: T0 })

      expect(owned?.rows).toEqual(FILE_A.rows)
    })

    it('isolates owners: another owner reads null, exactly as for a missing id', async () => {
      const ownerId = await createUser(prisma)
      const strangerId = await createUser(prisma)
      const saved = await repository.saveDraft(input(ownerId, FILE_A, T0))

      expect(
        await repository.findOwned({ ownerId: strangerId, importId: saved.import.id, now: T0 }),
      ).toBeNull()
      expect(await repository.findOwned({ ownerId, importId: 'missing', now: T0 })).toBeNull()
    })
  })

  describe('lazy 24 h expiry', () => {
    it('is still a draft 1 ms before expiresAt and expires exactly at it', async () => {
      const ownerId = await createUser(prisma)
      const saved = await repository.saveDraft(input(ownerId, FILE_A, T0))
      const importId = saved.import.id

      const justBefore = await repository.findOwned({
        ownerId,
        importId,
        now: new Date(TTL_END.getTime() - 1),
      })

      expect(justBefore?.import.status).toBe('DRAFT')
      expect(justBefore?.rows).toHaveLength(3)

      const atExpiry = await repository.findOwned({ ownerId, importId, now: TTL_END })

      expect(atExpiry?.import).toMatchObject({
        status: 'EXPIRED',
        sourceHash: FILE_A.sourceHash,
        rowCount: 3,
        copyCount: 4,
        expiresAt: TTL_END,
      })
      expect(atExpiry?.rows).toEqual([])
      expect(await prisma.libraryImportRow.count({ where: { importId } })).toBe(0)
    })

    it('never leaves an EXPIRED import with rows, nor a DRAFT past its TTL without rows', async () => {
      const ownerId = await createUser(prisma)
      await repository.saveDraft(input(ownerId, FILE_A, T0))

      expect(await repository.expireOwnerDrafts(ownerId, TTL_END)).toBe(1)

      const imports = await prisma.libraryImport.findMany({
        include: { _count: { select: { rows: true } } },
      })

      expect(imports.map((item) => [item.status, item._count.rows])).toEqual([['EXPIRED', 0]])
    })

    it('is scoped to the owner: another owner’s overdue draft is left as it is', async () => {
      const ownerId = await createUser(prisma)
      const otherId = await createUser(prisma)
      await repository.saveDraft(input(ownerId, FILE_A, T0))
      const other = await repository.saveDraft(input(otherId, FILE_B, T0))

      await repository.expireOwnerDrafts(ownerId, TTL_END)

      const untouched = await prisma.libraryImport.findUniqueOrThrow({
        where: { id: other.import.id },
      })

      expect(untouched.status).toBe('DRAFT')
      expect(await prisma.libraryImportRow.count({ where: { importId: other.import.id } })).toBe(1)
    })

    it('revives an EXPIRED import only from a re-supplied file, with new rows and a new TTL', async () => {
      const ownerId = await createUser(prisma)
      const created = await repository.saveDraft(input(ownerId, FILE_A, T0))
      const later = new Date(TTL_END.getTime() + 5 * HOUR_MS)
      const resupplied = { ...FILE_A, rows: FILE_A.rows.slice(0, 1), copyCount: 2 }

      await repository.expireOwnerDrafts(ownerId, TTL_END)

      const revived = await repository.saveDraft({ ownerId, now: later, ...resupplied })

      expect(revived.outcome).toBe('REVIVED')
      expect(revived.import).toMatchObject({
        id: created.import.id,
        status: 'DRAFT',
        rowCount: 1,
        copyCount: 2,
        createdAt: created.import.createdAt,
        expiresAt: new Date(later.getTime() + 24 * HOUR_MS),
      })

      const owned = await repository.findOwned({ ownerId, importId: created.import.id, now: later })

      expect(owned?.rows).toEqual(resupplied.rows)
    })

    it('never expires, revives or resets a COMMITTED import', async () => {
      const ownerId = await createUser(prisma)
      const committed = await prisma.libraryImport.create({
        data: {
          ownerId,
          sourceHash: FILE_A.sourceHash,
          status: 'COMMITTED',
          rowCount: 3,
          copyCount: 4,
          createdCopyCount: 3,
          expiresAt: TTL_END,
          committedAt: T0,
        },
      })
      const farFuture = new Date(TTL_END.getTime() + 1000 * HOUR_MS)

      expect(await repository.expireOwnerDrafts(ownerId, farFuture)).toBe(0)

      const again = await repository.saveDraft(input(ownerId, FILE_A, farFuture))

      expect(again.outcome).toBe('COMMITTED')
      expect(again.import).toMatchObject({
        id: committed.id,
        status: 'COMMITTED',
        createdCopyCount: 3,
        committedAt: T0,
        updatedAt: committed.updatedAt,
      })
      expect(await prisma.libraryImportRow.count()).toBe(0)
    })
  })

  describe('payload validation', () => {
    it('rejects an invalid row before writing anything', async () => {
      const ownerId = await createUser(prisma)
      const [first, second] = FILE_A.rows

      if (first === undefined || second === undefined) throw new Error('fixture rows missing')

      const invalidInputs: SaveLibraryImportDraftInput[] = [
        // INVALID without errors.
        { ...input(ownerId, FILE_A, T0), rows: [{ ...first, status: 'INVALID' }] },
        // READY with a row that has errors.
        { ...input(ownerId, FILE_A, T0), rows: [{ ...second, status: 'READY_CREATE_CHAIN' }] },
        // Duplicate row numbers.
        { ...input(ownerId, FILE_A, T0), rows: [first, { ...second, rowNumber: first.rowNumber }] },
        // Not a SHA-256 digest.
        { ...input(ownerId, FILE_A, T0), sourceHash: 'isbn13,title' },
        // No rows at all.
        { ...input(ownerId, FILE_A, T0), rows: [] },
      ]

      for (const invalid of invalidInputs) {
        await expect(repository.saveDraft(invalid)).rejects.toBeInstanceOf(
          LibraryImportPayloadError,
        )
      }

      expect(await prisma.libraryImport.count()).toBe(0)
      expect(await prisma.libraryImportRow.count()).toBe(0)
    })

    it('rejects a stored payload that no longer matches the contract, without echoing it', async () => {
      const ownerId = await createUser(prisma)
      const saved = await repository.saveDraft(input(ownerId, FILE_A, T0))

      await prisma.$executeRaw`
        UPDATE "LibraryImportRow"
        SET payload = jsonb_set(payload, '{values,quantity}', '999')
        WHERE "importId" = ${saved.import.id} AND "rowNumber" = 1
      `

      const error: unknown = await repository
        .findOwned({ ownerId, importId: saved.import.id, now: T0 })
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(LibraryImportPayloadError)
      expect(error).toMatchObject({ direction: 'read', rowNumber: 1 })
      expect(String(error)).not.toContain(SECRET_NOTE)
    })
  })

  it('performs no domain writes across save, read, expiry and revive', async () => {
    const graph = await createGraph(prisma)
    const before = await domainCounts(prisma)

    const saved = await repository.saveDraft(input(graph.ownerId, FILE_A, T0))
    await repository.findOwned({ ownerId: graph.ownerId, importId: saved.import.id, now: T0 })
    await repository.expireOwnerDrafts(graph.ownerId, TTL_END)
    await repository.saveDraft(input(graph.ownerId, FILE_A, TTL_END))

    expect(await domainCounts(prisma)).toEqual(before)
  })

  /**
   * Controlled overlap, not a bare `Promise.all`: an outside transaction (a
   * plain `pg` client) holds the lock both operations need, the test waits
   * until PostgreSQL itself reports both backends blocked on it, and only then
   * releases it. Each operation runs on its own `PrismaService` (own pool).
   */
  describe('concurrency', () => {
    let serviceA: PrismaService
    let serviceB: PrismaService
    let blocker: Client

    beforeEach(async () => {
      serviceA = newPrismaService()
      serviceB = newPrismaService()
      blocker = new Client({ connectionString: testDatabaseUrl() })
      await blocker.connect()
    })

    afterEach(async () => {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
      await serviceA.$disconnect()
      await serviceB.$disconnect()
      jest.restoreAllMocks()
    })

    it('two first-time saves of one owner/hash: one import, one set of rows, both succeed', async () => {
      const ownerId = await createUser(prisma)

      // An uncommitted insert of the same key: both saves find nothing under
      // FOR UPDATE and then block on the unique index when they insert.
      await blocker.query('BEGIN')
      await blocker.query(
        `INSERT INTO "LibraryImport" (id, "ownerId", "sourceHash", "rowCount", "copyCount", "expiresAt", "updatedAt")
         VALUES ('blocker', $1, $2, 1, 1, now(), now())`,
        [ownerId, FILE_A.sourceHash],
      )

      const transactionsA = jest.spyOn(serviceA, '$transaction')
      const transactionsB = jest.spyOn(serviceB, '$transaction')
      const saveA = new LibraryImportRepository(serviceA).saveDraft(input(ownerId, FILE_A, T0))
      const saveB = new LibraryImportRepository(serviceB).saveDraft(input(ownerId, FILE_A, T0))

      await waitForBlockedBackend(service, { expectedCount: 2 })
      await blocker.query('ROLLBACK')

      const results = await Promise.all([saveA, saveB])

      expect(results.map((result) => result.outcome).sort()).toEqual(['CREATED', 'EXISTING_DRAFT'])
      expect(results[0].import.id).toBe(results[1].import.id)
      // The loser's first transaction hit the unique violation and was rolled
      // back; its retry ran as a separate, second transaction.
      expect(transactionsA.mock.calls.length + transactionsB.mock.calls.length).toBe(3)
      expect(await prisma.libraryImport.count()).toBe(1)
      expect(await prisma.libraryImportRow.count()).toBe(FILE_A.rows.length)
    })

    it('two concurrent revives of one EXPIRED import: no doubled rows', async () => {
      const ownerId = await createUser(prisma)
      const created = await repository.saveDraft(input(ownerId, FILE_A, T0))
      await repository.expireOwnerDrafts(ownerId, TTL_END)

      await blocker.query('BEGIN')
      await blocker.query(`SELECT id FROM "LibraryImport" WHERE id = $1 FOR UPDATE`, [
        created.import.id,
      ])

      const later = new Date(TTL_END.getTime() + HOUR_MS)
      const reviveA = new LibraryImportRepository(serviceA).saveDraft(input(ownerId, FILE_A, later))
      const reviveB = new LibraryImportRepository(serviceB).saveDraft(input(ownerId, FILE_A, later))

      await waitForBlockedBackend(service, { expectedCount: 2 })
      await blocker.query('COMMIT')

      const results = await Promise.all([reviveA, reviveB])

      expect(results.map((result) => result.outcome).sort()).toEqual(['EXISTING_DRAFT', 'REVIVED'])

      const stored = await prisma.libraryImport.findUniqueOrThrow({
        where: { id: created.import.id },
      })

      expect(stored.status).toBe('DRAFT')
      expect(stored.expiresAt).toEqual(new Date(later.getTime() + 24 * HOUR_MS))
      expect(await prisma.libraryImportRow.count({ where: { importId: created.import.id } })).toBe(
        FILE_A.rows.length,
      )
    })

    /**
     * PostgreSQL grants a contended row lock to its waiters in arrival order,
     * so starting the second operation only after the first is reported
     * blocked fixes which one runs first once the blocker lets go.
     */
    it.each([
      ['the expiry acquires the lock first', 'expire-first'],
      ['the save acquires the lock first', 'save-first'],
    ] as const)(
      'expiry racing a save of the same overdue draft stays consistent when %s',
      async (_label, order) => {
        const ownerId = await createUser(prisma)
        const created = await repository.saveDraft(input(ownerId, FILE_A, T0))

        await blocker.query('BEGIN')
        await blocker.query(`SELECT id FROM "LibraryImport" WHERE id = $1 FOR UPDATE`, [
          created.import.id,
        ])

        const startExpire = (): Promise<number> =>
          new LibraryImportRepository(serviceA).expireOwnerDrafts(ownerId, TTL_END)
        const startSave = (): ReturnType<LibraryImportRepository['saveDraft']> =>
          new LibraryImportRepository(serviceB).saveDraft(input(ownerId, FILE_A, TTL_END))

        let expire: Promise<number>
        let save: ReturnType<LibraryImportRepository['saveDraft']>

        if (order === 'expire-first') {
          expire = startExpire()
          await waitForBlockedBackend(service, { expectedCount: 1 })
          save = startSave()
        } else {
          save = startSave()
          await waitForBlockedBackend(service, { expectedCount: 1 })
          expire = startExpire()
        }

        await waitForBlockedBackend(service, { expectedCount: 2 })
        await blocker.query('COMMIT')

        const [expired, saved] = await Promise.all([expire, save])

        // Expire-first: the expiry takes the draft, the save revives it.
        // Save-first: the save expires and revives it itself; the waiting
        // expiry then re-reads a draft with a fresh TTL and must leave it be.
        expect(expired).toBe(order === 'expire-first' ? 1 : 0)
        expect(saved.outcome).toBe('REVIVED')

        const stored = await prisma.libraryImport.findUniqueOrThrow({
          where: { id: created.import.id },
          include: { _count: { select: { rows: true } } },
        })

        expect(stored.status).toBe('DRAFT')
        expect(stored.expiresAt).toEqual(new Date(TTL_END.getTime() + 24 * HOUR_MS))
        expect(stored._count.rows).toBe(FILE_A.rows.length)

        const owned = await repository.findOwned({
          ownerId,
          importId: created.import.id,
          now: TTL_END,
        })

        expect(owned?.rows).toEqual(FILE_A.rows)
      },
    )
  })
})
