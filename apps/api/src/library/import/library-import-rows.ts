import {
  LIBRARY_IMPORT_COLUMN_VALUE_KEYS,
  LIBRARY_IMPORT_CSV_HEADER,
  libraryImportCsvColumnSchema,
  libraryImportCsvRowSchema,
  libraryImportQuantityCellSchema,
  type LibraryImportCsvCells,
  type LibraryImportCsvColumn,
  type LibraryImportRejectedCells,
  type LibraryImportRowError,
  type LibraryImportRowPayload,
  type LibraryImportRowValues,
} from '@bookswap/shared'

/**
 * Stage 8f-4: everything that happens to a row once it is a row.
 *
 * Extracted from the CSV parser when `.xlsx` arrived, and extracted rather than
 * copied on purpose: field validation, duplicate detection and the copy count
 * are import rules, not CSV rules. A second implementation behind the XLSX
 * reader would flag different rows than the file did, and the two would drift
 * the first time either side changed.
 *
 * The boundary this draws is the whole point of the format work: a reader's
 * only job is to produce `LibraryImportCsvCells` — 22 raw strings per row. From
 * here on nothing knows or cares which format they came from.
 */

export interface LibraryImportParsedRow {
  rowNumber: number
  /**
   * Without `rowVersion`: reading describes a file, and a version identifies a
   * STORED row. It is minted where draft records are built, so there is exactly
   * one place that decides when a row counts as changed.
   */
  payload: Omit<LibraryImportRowPayload, 'rowVersion'>
}

/**
 * Maps failed cell schemas to per-column row errors.
 *
 * Exported since 8f-2: an edited row re-parses through the same cell schemas as
 * a file, so its failures must map to the same per-column errors.
 */
export function libraryImportFieldErrors(
  issues: readonly { path: readonly PropertyKey[] }[],
): LibraryImportRowError[] {
  const failed = new Set(issues.map((issue) => issue.path[0]))

  return LIBRARY_IMPORT_CSV_HEADER.filter((column) => failed.has(column)).map(
    libraryImportFieldError,
  )
}

/** The one place that decides which of the two per-column codes a column gets. */
export function libraryImportFieldError(column: LibraryImportCsvColumn): LibraryImportRowError {
  return column === 'isbn13'
    ? { code: 'INVALID_ISBN', field: 'isbn13' }
    : { code: 'INVALID_FIELD', field: column }
}

/**
 * How a header row differs from the required one, as positions and known
 * column names only — never the text the file actually contained (R6a).
 *
 * Shared by both readers: a CSV header line and a spreadsheet's first row are
 * compared against the same contract, so they must report it the same way.
 */
export function libraryImportHeaderMismatch(actual: readonly string[]): {
  missingColumns: LibraryImportCsvColumn[]
  duplicateColumns: LibraryImportCsvColumn[]
  unknownColumnPositions: number[]
  orderMismatch: boolean
} {
  const seen = new Set<LibraryImportCsvColumn>()
  const duplicateColumns = new Set<LibraryImportCsvColumn>()
  const unknownColumnPositions: number[] = []

  actual.forEach((name, index) => {
    const column = libraryImportCsvColumnSchema.safeParse(name)

    if (!column.success) unknownColumnPositions.push(index + 1)
    else if (seen.has(column.data)) duplicateColumns.add(column.data)
    else seen.add(column.data)
  })

  return {
    missingColumns: LIBRARY_IMPORT_CSV_HEADER.filter((column) => !seen.has(column)),
    duplicateColumns: [...duplicateColumns],
    unknownColumnPositions,
    orderMismatch: actual.some((name, index) => name !== LIBRARY_IMPORT_CSV_HEADER[index]),
  }
}

/** True when the row is exactly the required header, in the required order. */
export function isLibraryImportHeader(record: readonly string[]): boolean {
  return (
    record.length === LIBRARY_IMPORT_CSV_HEADER.length &&
    record.every((name, index) => name === LIBRARY_IMPORT_CSV_HEADER[index])
  )
}

/**
 * Agreed rule: every normalized value except `quantity`, in header order.
 * Author order is part of the key; nothing beyond the shared schemas is
 * normalized.
 *
 * Exported since 8f-2: an edit can create or clear a duplicate, so the whole
 * draft is re-keyed after every PATCH with exactly this function.
 */
export function libraryImportDuplicateKey(values: LibraryImportRowValues): string {
  return JSON.stringify(
    LIBRARY_IMPORT_CSV_HEADER.filter((column) => column !== 'quantity').map(
      (column) => values[LIBRARY_IMPORT_COLUMN_VALUE_KEYS[column]] ?? null,
    ),
  )
}

/**
 * Raw cells → validated rows, with `DUPLICATE_ROW` resolved across the file.
 *
 * `rowNumber` is the 1-based position among data rows, which is what the draft,
 * the UI and every error message mean by "row" — not a physical line in a CSV
 * nor a spreadsheet row number.
 */
export function buildLibraryImportRows(
  records: readonly LibraryImportCsvCells[],
  /**
   * Cells a reader refused, by row. Their text is empty because nothing honest
   * could be written there, so the rejection — not the cell — is what keeps the
   * row out of a commit, and it is stored with the row so a later edit of some
   * OTHER column cannot make it disappear.
   */
  rejections: ReadonlyMap<number, LibraryImportRejectedCells> = new Map(),
): LibraryImportParsedRow[] {
  const firstRowByKey = new Map<string, number>()

  return records.map((cells, index) => {
    const rowNumber = index + 1
    const rejectedCells = rejections.get(rowNumber) ?? {}
    const parsed = libraryImportCsvRowSchema.safeParse(cells)
    const errors = mergeFieldErrors(
      parsed.success ? [] : libraryImportFieldErrors(parsed.error.issues),
      rejectedCells,
    )

    // A refused cell is a failed field, exactly as a malformed CSV cell is:
    // same `values: null`, same exclusion from the duplicate comparison, same
    // exclusion from the copy count. Anything softer would let the column's
    // default stand in for a value the file never carried.
    if (!parsed.success || errors.length > 0) {
      return {
        rowNumber,
        payload: { cells, values: null, errors, resolution: null, rejectedCells },
      }
    }

    const key = libraryImportDuplicateKey(parsed.data)
    const firstRowNumber = firstRowByKey.get(key)
    const duplicates: LibraryImportRowError[] = []

    if (firstRowNumber === undefined) {
      firstRowByKey.set(key, rowNumber)
    } else {
      duplicates.push({ code: 'DUPLICATE_ROW', firstRowNumber })
    }

    // 8f-2 resolves rows; reading a file only ever produces an unresolved payload.
    return {
      rowNumber,
      payload: { cells, values: parsed.data, errors: duplicates, resolution: null, rejectedCells },
    }
  })
}

/**
 * Header order, one error per column, schema failures and reader rejections
 * folded together.
 *
 * Exported since the two arrive from different places on an edit: the schema
 * re-reads the cells, while rejections are carried over from the stored row.
 */
export function mergeFieldErrors(
  fromSchema: readonly LibraryImportRowError[],
  rejected: LibraryImportRejectedCells,
): LibraryImportRowError[] {
  const columns = new Set<LibraryImportCsvColumn>(Object.keys(rejected) as LibraryImportCsvColumn[])

  for (const error of fromSchema) {
    if (error.code === 'INVALID_ISBN' || error.code === 'INVALID_FIELD') columns.add(error.field)
  }

  return LIBRARY_IMPORT_CSV_HEADER.filter((column) => columns.has(column)).map(
    libraryImportFieldError,
  )
}

/**
 * Agreed rule: valid quantities of ALL rows, duplicates and rows with other
 * field errors included; an empty cell counts as 1; an invalid quantity is not
 * replaced by 1 and adds nothing. Passing this cap does not make a file ready
 * to commit — 8g re-checks against the rows actually committed.
 */
export function countLibraryImportCopies(rows: readonly LibraryImportParsedRow[]): number {
  return rows.reduce((sum, row) => {
    // A refused `quantity` cell is empty, and an empty one means 1. Counting it
    // would be reading the default as the file's own answer — the very thing
    // R6a forbids for an invalid quantity.
    if (row.payload.rejectedCells.quantity !== undefined) return sum

    const quantity = libraryImportQuantityCellSchema.safeParse(row.payload.cells.quantity)

    return quantity.success ? sum + quantity.data : sum
  }, 0)
}
