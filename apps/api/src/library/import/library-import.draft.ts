import { randomUUID } from 'node:crypto'
import {
  LIBRARY_IMPORT_LIMITS,
  type LibraryImportCounts,
  type LibraryImportDraftResponse,
  type LibraryImportReadiness,
  type LibraryImportRowError,
  type LibraryImportRowRecord,
  type LibraryImportRowStatus,
  type LibraryImportRowValues,
} from '@bookswap/shared'
import { libraryImportDuplicateKey } from './library-import-csv.parser'
import type { LibraryImportSummary, OwnedLibraryImport } from './library-import.repository'
import type { ResolvedRow } from './library-import.resolver'

/**
 * Stage 8f-2: turning resolved rows into the one document `GET` and `PATCH`
 * both answer with (R12).
 *
 * Pure: no DB, no clock beyond the timestamps handed in. Everything a client
 * could otherwise compute for itself — counts, duplicates, readiness — is
 * derived here instead, so the row table and the commit button can never
 * disagree about the same draft.
 */

/** Errors decided at parse time; resolution never produces or removes them. */
const PARSE_ERROR_CODES = new Set(['INVALID_ISBN', 'INVALID_FIELD'])

export interface RowDraftInput {
  rowNumber: number
  cells: LibraryImportRowRecord['payload']['cells']
  values: LibraryImportRowValues | null
  /** Field-level errors from parsing; duplicates are recomputed, not carried. */
  fieldErrors: LibraryImportRowError[]
  skipped: boolean
  /**
   * The version this row keeps, or `undefined` to mint a new one.
   *
   * Agreed 8f-2 rule: only a row an explicit action touched gets a new version.
   * Rows merely recomputed alongside it — new duplicate flags, a new readiness —
   * keep theirs, so an unrelated concurrent action on them is not refused.
   */
  rowVersion: string | undefined
}

export function fieldErrorsOf(errors: readonly LibraryImportRowError[]): LibraryImportRowError[] {
  return errors.filter((error) => PARSE_ERROR_CODES.has(error.code))
}

/**
 * R6a: the first valid occurrence keeps its place, later ones are flagged.
 *
 * Skipped rows are out of the comparison entirely — they will create nothing,
 * so letting one hold the "first occurrence" slot would keep flagging a row
 * that is now the only real one. This is what makes skipping a genuine way to
 * resolve a duplicate, next to editing it (R6a: there is no "duplicates can
 * only be skipped" rule, and no "only skipping fixes them" either).
 */
export function duplicateErrors(rows: readonly RowDraftInput[]): Map<number, number> {
  const firstByKey = new Map<string, number>()
  const duplicates = new Map<number, number>()

  for (const row of rows) {
    if (row.skipped || row.values === null || row.fieldErrors.length > 0) continue

    const key = libraryImportDuplicateKey(row.values)
    const first = firstByKey.get(key)

    if (first === undefined) firstByKey.set(key, row.rowNumber)
    else duplicates.set(row.rowNumber, first)
  }

  return duplicates
}

/**
 * The status of one row, given everything known about it.
 *
 * Order matters and is not arbitrary: an explicit skip wins over every problem
 * (that is what skipping is for), and stable validation errors are decided
 * before resolution is even consulted — there is no point asking a provider
 * about a row whose ISBN column did not parse.
 */
export function toRowRecord(
  row: RowDraftInput,
  duplicate: number | undefined,
  resolved: ResolvedRow | undefined,
): LibraryImportRowRecord {
  const base = {
    rowNumber: row.rowNumber,
    cells: row.cells,
    values: row.values,
    rowVersion: row.rowVersion,
  }

  if (row.skipped) {
    return record({ ...base, status: 'SKIPPED', errors: row.fieldErrors, resolution: null })
  }

  const errors = [
    ...row.fieldErrors,
    ...(duplicate === undefined
      ? []
      : ([{ code: 'DUPLICATE_ROW', firstRowNumber: duplicate }] as LibraryImportRowError[])),
  ]

  if (errors.length > 0 || row.values === null) {
    return record({ ...base, status: 'INVALID', errors, resolution: null })
  }

  if (resolved === undefined) {
    return record({ ...base, status: 'NEEDS_REVIEW', errors: [], resolution: null })
  }

  return record({
    ...base,
    status: resolved.status,
    errors: resolved.errors,
    resolution: resolved.resolution,
  })
}

function record(input: {
  rowNumber: number
  status: LibraryImportRowStatus
  cells: LibraryImportRowRecord['payload']['cells']
  values: LibraryImportRowValues | null
  errors: LibraryImportRowError[]
  resolution: LibraryImportRowRecord['payload']['resolution']
  rowVersion: string | undefined
}): LibraryImportRowRecord {
  const { rowNumber, status, rowVersion, ...rest } = input

  return { rowNumber, status, payload: { ...rest, rowVersion: rowVersion ?? newRowVersion() } }
}

/**
 * Opaque and unique per state, never derived from the content: an edit that
 * goes A → B → A has to conflict with an operation that read the first A, and
 * any hash of the row would call that state unchanged.
 */
export function newRowVersion(): string {
  return randomUUID()
}

export function toCounts(rows: readonly LibraryImportRowRecord[]): LibraryImportCounts {
  const counts = {
    readyExistingEdition: 0,
    readyCreateChain: 0,
    needsReview: 0,
    invalid: 0,
    skipped: 0,
  }

  for (const row of rows) counts[COUNT_KEY[row.status]] += 1

  return counts
}

const COUNT_KEY = {
  READY_EXISTING_EDITION: 'readyExistingEdition',
  READY_CREATE_CHAIN: 'readyCreateChain',
  NEEDS_REVIEW: 'needsReview',
  INVALID: 'invalid',
  SKIPPED: 'skipped',
} as const satisfies Record<LibraryImportRowStatus, keyof LibraryImportCounts>

/**
 * R5: commit needs every row settled — and something left to create.
 *
 * `copyCount` is recounted over the rows that would actually be committed, not
 * taken from the parse-time figure: after edits and skips the two are different
 * numbers, and it is this one that the 500-copy cap applies to.
 */
export function toReadiness(rows: readonly LibraryImportRowRecord[]): LibraryImportReadiness {
  let copyCount = 0
  let unsettled = 0

  for (const row of rows) {
    if (row.status === 'SKIPPED') continue
    if (row.status === 'NEEDS_REVIEW' || row.status === 'INVALID') unsettled += 1
    else copyCount += row.payload.values?.quantity ?? 0
  }

  const canCommit = unsettled === 0 && copyCount > 0 && copyCount <= LIBRARY_IMPORT_LIMITS.maxCopies

  return { canCommit, copyCount }
}

export function toDraftResponse(owned: OwnedLibraryImport): LibraryImportDraftResponse {
  return {
    import: toSummaryResponse(owned.import),
    counts: toCounts(owned.rows),
    readiness: toReadiness(owned.rows),
    rows: owned.rows.map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      rowVersion: row.payload.rowVersion,
      cells: row.payload.cells,
      values: row.payload.values,
      errors: row.payload.errors,
      resolution: row.payload.resolution,
    })),
  }
}

function toSummaryResponse(summary: LibraryImportSummary): LibraryImportDraftResponse['import'] {
  return {
    id: summary.id,
    status: summary.status,
    rowCount: summary.rowCount,
    copyCount: summary.copyCount,
    createdCopyCount: summary.createdCopyCount,
    expiresAt: summary.expiresAt.toISOString(),
    committedAt: summary.committedAt?.toISOString() ?? null,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  }
}
