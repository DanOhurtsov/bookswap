import { Injectable } from '@nestjs/common'
import {
  LIBRARY_IMPORT_LIMITS,
  libraryImportRowRecordSchema,
  type LibraryImportRowRecord,
  type LibraryImportStatus,
} from '@bookswap/shared'
import { z } from 'zod'
import { isUniqueViolationOn } from '../../common/prisma-errors'
import { Prisma } from '../../generated/prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { LibraryImportPayloadError } from './library-import.errors'

/**
 * Stage 8f-1 (docs/plan/stage-8-inventory.md, R6, §5): persistence of CSV
 * import drafts. No HTTP, no catalog resolution, no commit — and no access to
 * any domain table (Work/Translation/Edition/Copy/Author): a draft is never a
 * domain write.
 *
 * Expiry is lazy and scoped to one owner: every read or save first expires
 * that owner's drafts past their TTL, deleting their rows (payload, private
 * `note` included) in the same transaction that marks them `EXPIRED`. There is
 * no scheduler.
 */

const OWNER_SOURCE_HASH_UNIQUE = 'LibraryImport_ownerId_sourceHash_key'

const DRAFT_TTL_MS = LIBRARY_IMPORT_LIMITS.draftTtlHours * 60 * 60 * 1000

/** 8g: room for the whole commit, and for waiting out one concurrent commit of the same import. */
const COMMIT_TIMEOUT_MS = 30_000
const COMMIT_MAX_WAIT_MS = 10_000

type TransactionClient = Pick<PrismaService, 'libraryImport' | 'libraryImportRow' | '$queryRaw'>

/**
 * What an `updateRows` callback may touch: the draft's own tables plus the
 * read-only catalog tables resolution consults. Deliberately narrower than the
 * full client — a draft is never a domain write, and the type says so.
 */
export type ImportReadClient = TransactionClient &
  Pick<PrismaService, 'edition' | 'work' | 'externalBookLookup'>

/**
 * Stage 8g: what a commit callback may touch — the catalog chain of §3 plus
 * `Copy`.
 *
 * The one place in this file that hands out a write client, and it is named so
 * that the difference from {@link ImportReadClient} is visible at every call
 * site. `Loan` is absent on purpose: an import creates books at home, never a
 * lending arrangement.
 */
export type ImportCommitClient = TransactionClient &
  Pick<PrismaService, 'author' | 'work' | 'workAuthor' | 'translation' | 'edition' | 'copy'>

const IMPORT_SUMMARY_SELECT = {
  id: true,
  ownerId: true,
  sourceHash: true,
  status: true,
  rowCount: true,
  copyCount: true,
  createdCopyCount: true,
  expiresAt: true,
  committedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface LibraryImportSummary {
  id: string
  ownerId: string
  sourceHash: string
  status: LibraryImportStatus
  rowCount: number
  copyCount: number
  createdCopyCount: number | null
  expiresAt: Date
  committedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface SaveLibraryImportDraftInput {
  ownerId: string
  /** From a successful `parseLibraryImportCsv` — the caller never passes an unverified file. */
  sourceHash: string
  copyCount: number
  rows: readonly LibraryImportRowRecord[]
  now: Date
}

export type SaveLibraryImportDraftOutcome =
  /** No import with this owner/hash existed. */
  | 'CREATED'
  /** A live draft already exists; it is returned untouched. */
  | 'EXISTING_DRAFT'
  /** An expired draft was restored from the re-supplied file, with a new TTL. */
  | 'REVIVED'
  /** Already committed; never reset — the caller returns the previous summary. */
  | 'COMMITTED'

export interface SaveLibraryImportDraftResult {
  outcome: SaveLibraryImportDraftOutcome
  import: LibraryImportSummary
}

/** 8g: whether this call did the committing, or found it already done. */
export interface CommitLibraryImportResult {
  outcome: 'COMMITTED' | 'ALREADY_COMMITTED'
  import: LibraryImportSummary
}

export interface OwnedLibraryImport {
  import: LibraryImportSummary
  /** Ordered by `rowNumber`; empty for `EXPIRED` and (after 8g) `COMMITTED`. */
  rows: LibraryImportRowRecord[]
}

const draftShapeSchema = z.object({
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  copyCount: z.number().int().min(0).max(LIBRARY_IMPORT_LIMITS.maxCopies),
  rows: z.array(z.unknown()).min(1).max(LIBRARY_IMPORT_LIMITS.maxDataRows),
})

@Injectable()
export class LibraryImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One import per `(ownerId, sourceHash)`. `SELECT … FOR UPDATE` serializes
   * concurrent saves of an import that already exists, but cannot lock a row
   * that does not exist yet: two first-time saves of the same file both insert,
   * and the loser gets a unique violation that aborts its whole transaction.
   * That transaction is left to roll back completely; the retry runs as a NEW
   * transaction afterwards, which then finds the winner's committed row.
   */
  async saveDraft(input: SaveLibraryImportDraftInput): Promise<SaveLibraryImportDraftResult> {
    const rows = validateRowsForWrite(input)

    try {
      return await this.prisma.$transaction((tx) => saveDraftInTransaction(tx, input, rows))
    } catch (error) {
      if (!isUniqueViolationOn(error, OWNER_SOURCE_HASH_UNIQUE)) throw error
    }

    return this.prisma.$transaction((tx) => saveDraftInTransaction(tx, input, rows))
  }

  /** The owner's import with validated rows, or `null` — a foreign id is indistinguishable from a missing one. */
  async findOwned(input: {
    ownerId: string
    importId: string
    now: Date
  }): Promise<OwnedLibraryImport | null> {
    return this.prisma.$transaction(async (tx) => {
      await expireOwnerDrafts(tx, input.ownerId, input.now)

      return readOwned(tx, { ownerId: input.ownerId, id: input.importId })
    })
  }

  /**
   * Stage 8f-2: the same read keyed by `(ownerId, sourceHash)`.
   *
   * A repeated preview answers from here — a live draft or a finished summary
   * comes back untouched (R6), and only a missing or expired import is worth
   * resolving and writing again.
   */
  async findOwnedByHash(input: {
    ownerId: string
    sourceHash: string
    now: Date
  }): Promise<OwnedLibraryImport | null> {
    return this.prisma.$transaction(async (tx) => {
      await expireOwnerDrafts(tx, input.ownerId, input.now)

      return readOwned(tx, { ownerId: input.ownerId, sourceHash: input.sourceHash })
    })
  }

  /**
   * Stage 8f-2: the one way a draft's rows change after it exists.
   *
   * The import row is locked for the whole operation, so a PATCH cannot
   * interleave with another PATCH, with lazy expiry, or with the revive half of
   * a concurrent preview. `apply` runs inside that lock and is handed a
   * read-only client: it may look things up (editions, the lookup cache,
   * candidates) but not write, and it must never make an external call — those
   * belong before this method is called (R7).
   *
   * Returns `null` when the import is not this owner's, and leaves everything
   * untouched when `apply` throws: one transaction, so a rejected PATCH cannot
   * land half-written.
   */
  async updateRows(input: {
    ownerId: string
    importId: string
    now: Date
    apply: (context: {
      client: ImportReadClient
      owned: OwnedLibraryImport
    }) => Promise<readonly LibraryImportRowRecord[]>
  }): Promise<OwnedLibraryImport | null> {
    return this.prisma.$transaction(async (tx) => {
      await expireOwnerDrafts(tx, input.ownerId, input.now)
      await tx.$queryRaw`
        SELECT "id" FROM "LibraryImport"
        WHERE "id" = ${input.importId} AND "ownerId" = ${input.ownerId}
        FOR UPDATE
      `

      const owned = await readOwned(tx, { ownerId: input.ownerId, id: input.importId })

      if (owned === null) return null

      const next = validateRows(await input.apply({ client: tx, owned }))

      if (next.length > 0) {
        // Rewritten wholesale, not patched row by row: every row's status,
        // errors and duplicate flag are recomputed together, and two statements
        // do it regardless of how many rows the file has.
        await tx.libraryImportRow.deleteMany({ where: { importId: input.importId } })
        await insertRows(tx, input.importId, next)
      }

      return readOwned(tx, { ownerId: input.ownerId, id: input.importId })
    })
  }

  /**
   * Stage 8g (R6c): the one transaction in which an import becomes real.
   *
   * The import row is locked for the whole operation — the same lock a `PATCH`
   * takes — so a commit cannot interleave with a row edit, with lazy expiry, or
   * with a second commit. `apply` runs inside that lock with a write client and
   * returns the ids of the copies it created; this method then marks the import
   * `COMMITTED` and deletes its rows, payloads and private notes included.
   *
   * Everything is one transaction, so `apply` throwing leaves no half-import
   * behind: not a `Work`, not an `Author`, not a single `Copy`.
   *
   * Order matters and is agreed (R6c): an already-`COMMITTED` import answers
   * with its stored summary immediately after the OWNER check, before any TTL
   * or draft-version test. A retry after a lost response arrives without rows to
   * hash and possibly past the original TTL, and it is exactly then that
   * answering it correctly matters most.
   *
   * Returns `null` when the import is not this owner's — a foreign id and a
   * missing one are indistinguishable from outside.
   */
  async commit(input: {
    ownerId: string
    importId: string
    now: Date
    apply: (context: {
      client: ImportCommitClient
      owned: OwnedLibraryImport
    }) => Promise<readonly string[]>
  }): Promise<CommitLibraryImportResult | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await expireOwnerDrafts(tx, input.ownerId, input.now)
        await tx.$queryRaw`
          SELECT "id" FROM "LibraryImport"
          WHERE "id" = ${input.importId} AND "ownerId" = ${input.ownerId}
          FOR UPDATE
        `

        const owned = await readOwned(tx, { ownerId: input.ownerId, id: input.importId })

        if (owned === null) return null

        if (owned.import.status === 'COMMITTED') {
          return { outcome: 'ALREADY_COMMITTED' as const, import: owned.import }
        }

        const copyIds = await input.apply({ client: tx, owned })

        await tx.libraryImportRow.deleteMany({ where: { importId: input.importId } })
        await tx.libraryImport.update({
          where: { id: input.importId },
          data: {
            status: 'COMMITTED',
            committedAt: input.now,
            createdCopyCount: copyIds.length,
          },
        })

        return { outcome: 'COMMITTED' as const, import: await readSummary(tx, input.importId) }
      },
      // Explicit rather than Prisma's 5 s default. The work inside is a fixed
      // handful of statements whatever the row count, but 500 copies and a
      // `bookswap_norm` round trip on a cold connection have no business racing
      // a timeout that was chosen for a single `update`.
      { timeout: COMMIT_TIMEOUT_MS, maxWait: COMMIT_MAX_WAIT_MS },
    )
  }

  /** Lazily expires this owner's overdue drafts. Returns how many were expired. */
  async expireOwnerDrafts(ownerId: string, now: Date): Promise<number> {
    return this.prisma.$transaction((tx) => expireOwnerDrafts(tx, ownerId, now))
  }
}

async function readOwned(
  tx: TransactionClient,
  where: { ownerId: string; id?: string; sourceHash?: string },
): Promise<OwnedLibraryImport | null> {
  const found = await tx.libraryImport.findFirst({
    where,
    select: {
      ...IMPORT_SUMMARY_SELECT,
      rows: {
        select: { rowNumber: true, status: true, payload: true },
        orderBy: { rowNumber: 'asc' },
      },
    },
  })

  if (found === null) return null

  const { rows, ...summary } = found

  return { import: summary, rows: rows.map(validateRowOnRead) }
}

async function saveDraftInTransaction(
  tx: TransactionClient,
  input: SaveLibraryImportDraftInput,
  rows: readonly LibraryImportRowRecord[],
): Promise<SaveLibraryImportDraftResult> {
  await expireOwnerDrafts(tx, input.ownerId, input.now)

  const [existing] = await tx.$queryRaw<{ id: string; status: LibraryImportStatus }[]>`
    SELECT "id", "status" FROM "LibraryImport"
    WHERE "ownerId" = ${input.ownerId} AND "sourceHash" = ${input.sourceHash}
    FOR UPDATE
  `
  const draft = {
    status: 'DRAFT' as const,
    rowCount: rows.length,
    copyCount: input.copyCount,
    expiresAt: new Date(input.now.getTime() + DRAFT_TTL_MS),
  }

  if (existing === undefined) {
    const created = await tx.libraryImport.create({
      data: { ...draft, ownerId: input.ownerId, sourceHash: input.sourceHash },
      select: { id: true },
    })

    await insertRows(tx, created.id, rows)

    return { outcome: 'CREATED', import: await readSummary(tx, created.id) }
  }

  if (existing.status === 'EXPIRED') {
    // An EXPIRED import has no rows; deleting again keeps the revive correct
    // even if that invariant were ever broken by a write outside this class.
    await tx.libraryImportRow.deleteMany({ where: { importId: existing.id } })
    await tx.libraryImport.update({ where: { id: existing.id }, data: draft })
    await insertRows(tx, existing.id, rows)

    return { outcome: 'REVIVED', import: await readSummary(tx, existing.id) }
  }

  const outcome = existing.status === 'DRAFT' ? 'EXISTING_DRAFT' : 'COMMITTED'

  return { outcome, import: await readSummary(tx, existing.id) }
}

/**
 * Marks the owner's overdue drafts `EXPIRED` and deletes their rows, inside the
 * caller's transaction. Candidates are locked in a stable order, then re-read:
 * under READ COMMITTED that second statement sees whatever a concurrent save
 * committed while this one waited for the lock, so a draft revived meanwhile
 * (new TTL) is left alone together with its new rows. Timestamps are compared
 * by Prisma, not in raw SQL, so no session time zone can shift the boundary.
 */
async function expireOwnerDrafts(
  tx: TransactionClient,
  ownerId: string,
  now: Date,
): Promise<number> {
  const overdue = { ownerId, status: 'DRAFT' as const, expiresAt: { lte: now } }
  const candidates = await tx.libraryImport.findMany({
    where: overdue,
    select: { id: true },
    orderBy: { id: 'asc' },
  })

  if (candidates.length === 0) return 0

  await tx.$queryRaw`
    SELECT "id" FROM "LibraryImport"
    WHERE "id" IN (${Prisma.join(candidates.map((candidate) => candidate.id))})
    ORDER BY "id"
    FOR UPDATE
  `

  const locked = await tx.libraryImport.findMany({
    where: { ...overdue, id: { in: candidates.map((candidate) => candidate.id) } },
    select: { id: true },
  })
  const ids = locked.map((row) => row.id)

  if (ids.length === 0) return 0

  await tx.libraryImportRow.deleteMany({ where: { importId: { in: ids } } })
  await tx.libraryImport.updateMany({
    where: { ...overdue, id: { in: ids } },
    data: { status: 'EXPIRED' },
  })

  return ids.length
}

async function insertRows(
  tx: TransactionClient,
  importId: string,
  rows: readonly LibraryImportRowRecord[],
): Promise<void> {
  await tx.libraryImportRow.createMany({
    data: rows.map((row) => ({
      importId,
      rowNumber: row.rowNumber,
      status: row.status,
      payload: toJsonObject(row.payload),
    })),
  })
}

async function readSummary(tx: TransactionClient, id: string): Promise<LibraryImportSummary> {
  return tx.libraryImport.findUniqueOrThrow({ where: { id }, select: IMPORT_SUMMARY_SELECT })
}

function validateRowsForWrite(input: SaveLibraryImportDraftInput): LibraryImportRowRecord[] {
  if (!draftShapeSchema.safeParse(input).success) {
    throw new LibraryImportPayloadError('write', undefined)
  }

  return validateRows(input.rows)
}

/** Every row re-validated against the shared contract, with `rowNumber` unique. */
function validateRows(rows: readonly LibraryImportRowRecord[]): LibraryImportRowRecord[] {
  const seen = new Set<number>()

  return rows.map((row) => {
    const parsed = libraryImportRowRecordSchema.safeParse(row)

    if (!parsed.success || seen.has(parsed.data.rowNumber)) {
      throw new LibraryImportPayloadError(
        'write',
        parsed.success ? parsed.data.rowNumber : undefined,
      )
    }

    seen.add(parsed.data.rowNumber)

    return parsed.data
  })
}

function validateRowOnRead(row: {
  rowNumber: number
  status: string
  payload: Prisma.JsonValue
}): LibraryImportRowRecord {
  const parsed = libraryImportRowRecordSchema.safeParse(row)

  if (!parsed.success) throw new LibraryImportPayloadError('read', row.rowNumber)

  return parsed.data
}

type JsonInput = Prisma.InputJsonValue | null

/**
 * Validated payloads carry optional keys as `undefined`; JSON has no such
 * value. Dropping them here yields exactly what a JSON round trip would, typed
 * for Prisma without a cast.
 */
function toJson(value: unknown): JsonInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === 'object') return toJsonObject(value)

  throw new LibraryImportPayloadError('write', undefined)
}

function toJsonObject(value: object): Prisma.InputJsonObject {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)

  return Object.fromEntries(entries.map(([key, item]) => [key, toJson(item)]))
}
