import {
  LIBRARY_IMPORT_LIMITS,
  type LibraryImportNotReadyDetails,
  type LibraryImportResolvedCatalog,
  type LibraryImportRowRecord,
  type LibraryImportRowValues,
} from '@bookswap/shared'

/**
 * Stage 8g (R6c): what a draft would create, worked out from the draft alone.
 *
 * Pure — no Prisma, no clock, no HTTP. That is what lets the very same function
 * answer two questions that must never disagree: what `readiness.blockers` tells
 * the owner before they press the button, and what the commit re-checks under
 * its lock a moment later. Two implementations of "is this importable" would
 * drift the first time either side changed, and the drift would show up as a
 * button that is enabled for an endpoint that refuses.
 *
 * What it deliberately does NOT decide is anything about the catalog as it is
 * right now — a merged `Work`, an `Edition` that appeared since the preview.
 * Those are not properties of the draft, and pretending to know them here would
 * mean holding a stale answer.
 */

/** Rows that still owe the owner a decision. */
const UNRESOLVED_STATUSES = new Set(['NEEDS_REVIEW', 'INVALID'])

export interface PlannedCopy {
  rowNumber: number
  quantity: number
  /**
   * Copy fields stay the row's own (R6c): rows sharing one ISBN share a catalog
   * chain, never a condition or a private note. Those are what describe the
   * particular physical books on a shelf, and merging them would invent a state
   * the file never described.
   */
  values: LibraryImportRowValues
  /** Which `Edition` these copies land on: one that exists, or one this plan creates. */
  target: { kind: 'EXISTING'; editionId: string } | { kind: 'CHAIN'; isbn13: string }
}

/** One new catalog chain, shared by every row of its ISBN group. */
export interface PlannedChain {
  isbn13: string
  rowNumbers: number[]
  /** The existing `Work` the owner chose, or `null` for "create a new one". */
  workId: string | null
  catalog: LibraryImportResolvedCatalog
}

export interface LibraryImportCommitPlan {
  chains: PlannedChain[]
  copies: PlannedCopy[]
  /** Copies this plan would create — the live figure the 500 cap applies to. */
  copyCount: number
}

export interface LibraryImportCommitAssessment {
  blockers: LibraryImportNotReadyDetails[]
  /** Meaningful only when `blockers` is empty; otherwise a partial best effort. */
  plan: LibraryImportCommitPlan
}

/**
 * The draft's own verdict on itself.
 *
 * Order of blockers is stable (the order of the reasons below), so a client that
 * shows only the first one shows the same first one every time.
 */
export function assessLibraryImportCommit(
  rows: readonly LibraryImportRowRecord[],
): LibraryImportCommitAssessment {
  const blockers: LibraryImportNotReadyDetails[] = []
  const unresolved = rows.flatMap((row) =>
    UNRESOLVED_STATUSES.has(row.status) ? [row.rowNumber] : [],
  )

  if (unresolved.length > 0) blockers.push({ reason: 'ROWS_UNRESOLVED', rowNumbers: unresolved })

  const committable = rows.filter(
    (row) => row.status === 'READY_EXISTING_EDITION' || row.status === 'READY_CREATE_CHAIN',
  )

  if (committable.length === 0) blockers.push({ reason: 'NOTHING_TO_IMPORT' })

  const groups = groupByIsbn(committable)
  const conflicting = groups.flatMap((group) => (isCoherent(group) ? [] : group.rowNumbers))

  if (conflicting.length > 0) {
    blockers.push({ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: conflicting.sort(byNumber) })
  }

  return { blockers, plan: toPlan(groups) }
}

/** The 500-copy cap, re-checked against what would actually be created (R7a). */
export function exceedsCopyCap(copyCount: number): boolean {
  return copyCount > LIBRARY_IMPORT_LIMITS.maxCopies
}

interface IsbnGroup {
  isbn13: string
  rowNumbers: number[]
  members: { row: LibraryImportRowRecord; values: LibraryImportRowValues }[]
}

/**
 * Rows keyed by the ISBN they are about.
 *
 * A `READY_*` row always has `values` (the shared row contract refuses the
 * combination otherwise), so the ISBN is always known here.
 */
function groupByIsbn(rows: readonly LibraryImportRowRecord[]): IsbnGroup[] {
  const groups = new Map<string, IsbnGroup>()

  for (const row of rows) {
    const values = row.payload.values

    if (values === null) continue

    const group = groups.get(values.isbn13) ?? {
      isbn13: values.isbn13,
      rowNumbers: [],
      members: [],
    }

    group.rowNumbers.push(row.rowNumber)
    group.members.push({ row, values })
    groups.set(values.isbn13, group)
  }

  return [...groups.values()]
}

/**
 * Whether every row of one ISBN group asks for the same thing (R6c).
 *
 * Three ways to disagree, and all three are refusals rather than a silent pick:
 *
 * 1. Some rows point at an `Edition` that exists while others would create one.
 *    A draft can genuinely reach this: one row resolved before somebody added
 *    that ISBN to the catalog, another was retried after.
 * 2. Different resolved catalogs — the file describes the same ISBN twice, with
 *    different metadata. Taking the first row's version would import data the
 *    owner never saw chosen.
 * 3. Different `workId`, "new" against "existing" included. The metadata may be
 *    identical and it still names two different works; there is nothing here to
 *    merge, only a question to answer.
 */
function isCoherent(group: IsbnGroup): boolean {
  const [first, ...rest] = group.members

  if (first === undefined) return true

  const head = first.row.payload.resolution

  if (head === null) return false

  return rest.every(({ row }) => {
    const resolution = row.payload.resolution

    if (resolution === null || resolution.kind !== head.kind) return false

    if (head.kind === 'EXISTING_EDITION') {
      return resolution.kind === 'EXISTING_EDITION' && resolution.editionId === head.editionId
    }

    return (
      resolution.kind === 'CREATE_CHAIN' &&
      resolution.workId === head.workId &&
      canonicalJson(resolution.catalog) === canonicalJson(head.catalog)
    )
  })
}

function toPlan(groups: readonly IsbnGroup[]): LibraryImportCommitPlan {
  const chains: PlannedChain[] = []
  const copies: PlannedCopy[] = []

  for (const group of groups) {
    const head = group.members[0]?.row.payload.resolution

    if (head === undefined || head === null) continue

    const target: PlannedCopy['target'] =
      head.kind === 'EXISTING_EDITION'
        ? { kind: 'EXISTING', editionId: head.editionId }
        : { kind: 'CHAIN', isbn13: group.isbn13 }

    if (head.kind === 'CREATE_CHAIN') {
      chains.push({
        isbn13: group.isbn13,
        rowNumbers: [...group.rowNumbers],
        workId: head.workId,
        catalog: head.catalog,
      })
    }

    for (const member of group.members) {
      copies.push({
        rowNumber: member.row.rowNumber,
        quantity: member.values.quantity,
        values: member.values,
        target,
      })
    }
  }

  copies.sort((left, right) => byNumber(left.rowNumber, right.rowNumber))

  return {
    chains,
    copies,
    copyCount: copies.reduce((total, copy) => total + copy.quantity, 0),
  }
}

function byNumber(left: number, right: number): number {
  return left - right
}

/**
 * A stable string for a resolved catalog, with object keys sorted at every depth.
 *
 * `JSON.stringify` alone would compare key ORDER as well as content, and the two
 * sides of a comparison here reach us by different routes — one straight from
 * the resolver, one round-tripped through a JSONB column. Sorting removes the
 * only way those could differ without the books differing.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)

  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => [key, sortKeys(item)]),
  )
}
