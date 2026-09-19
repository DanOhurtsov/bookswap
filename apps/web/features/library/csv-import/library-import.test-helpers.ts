import {
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_DEFAULTS,
  libraryImportDraftResponseSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
  type LibraryImportRowError,
  type LibraryImportRowResponse,
  type LibraryImportRowStatus,
} from '@bookswap/shared'

/**
 * Realistic fixtures for 8f-3's tests.
 *
 * Every draft built here is parsed through `libraryImportDraftResponseSchema`
 * before a test sees it, so a fixture that has drifted from the shared contract
 * fails loudly at construction instead of quietly letting a component be tested
 * against a shape the API never sends.
 */

export const VALID_ISBN = '9780306406157'
export const SECOND_ISBN = '9783161484100'

export function buildCells(overrides: Partial<LibraryImportCsvCells> = {}): LibraryImportCsvCells {
  const empty = Object.fromEntries(
    LIBRARY_IMPORT_CSV_HEADER.map((column) => [column, '']),
  ) as LibraryImportCsvCells

  return { ...empty, isbn13: VALID_ISBN, ...overrides }
}

interface RowOptions {
  rowNumber: number
  status: LibraryImportRowStatus
  rowVersion: string
  cells?: Partial<LibraryImportCsvCells>
  errors?: LibraryImportRowError[]
  withValues?: boolean
}

export function buildRow({
  rowNumber,
  status,
  rowVersion,
  cells = {},
  errors = [],
  withValues = true,
}: RowOptions): LibraryImportRowResponse {
  const merged = buildCells(cells)

  return {
    rowNumber,
    status,
    rowVersion,
    cells: merged,
    values: withValues
      ? {
          isbn13: merged.isbn13,
          ...(merged.title === '' ? {} : { title: merged.title }),
          format: LIBRARY_IMPORT_DEFAULTS.format,
          condition: LIBRARY_IMPORT_DEFAULTS.condition,
          visibility: LIBRARY_IMPORT_DEFAULTS.visibility,
          ...(merged.note === '' ? {} : { note: merged.note }),
          quantity: merged.quantity === '' ? 1 : Number(merged.quantity),
        }
      : null,
    errors,
    rejectedCells: {},
    resolution:
      status === 'READY_EXISTING_EDITION'
        ? { kind: 'EXISTING_EDITION', editionId: 'edition-1', workId: 'work-1' }
        : null,
  }
}

interface DraftOptions {
  id?: string
  rows: LibraryImportRowResponse[]
  status?: LibraryImportDraftResponse['import']['status']
  canCommit?: boolean
  copyCount?: number
  createdCopyCount?: number | null
}

export function buildDraft({
  id = 'import-1',
  rows,
  status = 'DRAFT',
  canCommit,
  copyCount,
  createdCopyCount = null,
}: DraftOptions): LibraryImportDraftResponse {
  const tally = (wanted: LibraryImportRowStatus): number =>
    rows.filter((row) => row.status === wanted).length

  const ready = tally('READY_EXISTING_EDITION') + tally('READY_CREATE_CHAIN')
  const unresolved = tally('NEEDS_REVIEW') + tally('INVALID')

  return libraryImportDraftResponseSchema.parse({
    import: {
      id,
      status,
      rowCount: rows.length,
      copyCount: copyCount ?? rows.length,
      createdCopyCount,
      expiresAt: '2026-09-20T10:00:00.000Z',
      committedAt: status === 'COMMITTED' ? '2026-09-19T10:00:00.000Z' : null,
      createdAt: '2026-09-19T09:00:00.000Z',
      updatedAt: '2026-09-19T09:30:00.000Z',
    },
    counts: {
      readyExistingEdition: tally('READY_EXISTING_EDITION'),
      readyCreateChain: tally('READY_CREATE_CHAIN'),
      needsReview: tally('NEEDS_REVIEW'),
      invalid: tally('INVALID'),
      skipped: tally('SKIPPED'),
    },
    readiness: {
      canCommit: canCommit ?? (unresolved === 0 && ready > 0),
      copyCount: copyCount ?? ready,
    },
    rows,
  })
}
