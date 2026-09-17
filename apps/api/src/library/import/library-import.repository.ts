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

type TransactionClient = Pick<PrismaService, 'libraryImport' | 'libraryImportRow' | '$queryRaw'>

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

      const found = await tx.libraryImport.findFirst({
        where: { id: input.importId, ownerId: input.ownerId },
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
    })
  }

  /** Lazily expires this owner's overdue drafts. Returns how many were expired. */
  async expireOwnerDrafts(ownerId: string, now: Date): Promise<number> {
    return this.prisma.$transaction((tx) => expireOwnerDrafts(tx, ownerId, now))
  }
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

  const seen = new Set<number>()

  return input.rows.map((row) => {
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
