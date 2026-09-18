import { createHash } from 'node:crypto'
import { CsvError, parse } from 'csv-parse/sync'
import {
  API_ERROR_CODES,
  LIBRARY_IMPORT_COLUMN_VALUE_KEYS,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  libraryImportCsvCellsSchema,
  libraryImportCsvColumnSchema,
  libraryImportCsvRowSchema,
  libraryImportQuantityCellSchema,
  type LibraryImportCsvCells,
  type LibraryImportCsvColumn,
  type LibraryImportDelimiter,
  type LibraryImportInvalidCsvDetails,
  type LibraryImportRowError,
  type LibraryImportRowPayload,
  type LibraryImportRowValues,
  type LibraryImportTooLargeDetails,
} from '@bookswap/shared'

/**
 * Stage 8f-1 (docs/plan/stage-8-inventory.md, R4–R6): syntax and field
 * validation of a CSV v1 import. No catalog resolution and no I/O — that is
 * 8f-2.
 *
 * A pure function that returns every expected failure as a value instead of
 * throwing: nothing a user can put in a file may crash the process. It never
 * logs, and no error detail carries file content (R4: raw CSV and the private
 * `note` stay out of logs).
 */

export type LibraryImportCsvError =
  | { code: typeof API_ERROR_CODES.IMPORT_TOO_LARGE; details: LibraryImportTooLargeDetails }
  | { code: typeof API_ERROR_CODES.IMPORT_INVALID_CSV; details: LibraryImportInvalidCsvDetails }

export interface LibraryImportParsedRow {
  rowNumber: number
  /**
   * Without `rowVersion`: parsing describes a file, and a version identifies a
   * STORED row. It is minted where draft records are built, so there is exactly
   * one place that decides when a row counts as changed.
   */
  payload: Omit<LibraryImportRowPayload, 'rowVersion'>
}

export type LibraryImportCsvParseResult =
  | {
      ok: true
      delimiter: LibraryImportDelimiter
      /** R6: SHA-256 (hex) of the received bytes with one leading BOM removed. */
      sourceHash: string
      rows: LibraryImportParsedRow[]
      /** Sum of the valid `quantity` cells over all rows — see `countCopies`. */
      copyCount: number
    }
  | { ok: false; error: LibraryImportCsvError }

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf)

/** Longest first, so `\r\n` is one record break; mixed line endings in one file are accepted. */
const RECORD_DELIMITERS = ['\r\n', '\n', '\r']

/**
 * A defensive bound only: `csv-parse` counts characters, and a record can never
 * hold more characters than the whole file has bytes — so this can reject no row
 * that the 48 KiB file limit allows.
 */
const MAX_RECORD_SIZE = LIBRARY_IMPORT_LIMITS.maxBytes

const COLUMN_COUNT_ERROR_CODES: ReadonlySet<string> = new Set([
  'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH',
  'CSV_RECORD_INCONSISTENT_COLUMNS',
])

type Failure = { ok: false; error: LibraryImportCsvError }

function invalidCsv(details: LibraryImportInvalidCsvDetails): Failure {
  return { ok: false, error: { code: API_ERROR_CODES.IMPORT_INVALID_CSV, details } }
}

function tooLarge(details: LibraryImportTooLargeDetails): Failure {
  return { ok: false, error: { code: API_ERROR_CODES.IMPORT_TOO_LARGE, details } }
}

/** Removes exactly one leading BOM. A second one stays and fails the header check. */
function stripOneBom(input: Uint8Array): Uint8Array {
  const hasBom = UTF8_BOM.every((byte, index) => input[index] === byte)

  return hasBom ? input.subarray(UTF8_BOM.length) : input
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    // `ignoreBOM: true` keeps a BOM as U+FEFF: the one allowed BOM is already gone.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function detectDelimiter(text: string): LibraryImportDelimiter | Failure {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const hasComma = firstLine.includes(',')
  const hasSemicolon = firstLine.includes(';')

  if (hasComma && hasSemicolon) return invalidCsv({ reason: 'AMBIGUOUS_DELIMITER' })
  if (hasComma) return ','
  if (hasSemicolon) return ';'

  return invalidCsv(headerMismatch([firstLine]))
}

function readRecords(text: string, delimiter: LibraryImportDelimiter): string[][] | Failure {
  try {
    return parse(text, {
      delimiter,
      record_delimiter: RECORD_DELIMITERS,
      // The single allowed BOM was removed before decoding; letting the parser
      // strip another one would turn a double BOM into a valid header.
      bom: false,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      cast: false,
      cast_date: false,
      trim: false,
      max_record_size: MAX_RECORD_SIZE,
    })
  } catch (error) {
    if (!(error instanceof CsvError)) throw error

    const line = typeof error.lines === 'number' && error.lines > 0 ? error.lines : 1
    const reason = COLUMN_COUNT_ERROR_CODES.has(error.code) ? 'COLUMN_COUNT' : 'MALFORMED_CSV'

    return invalidCsv({ reason, line })
  }
}

function headerMismatch(actual: readonly string[]): LibraryImportInvalidCsvDetails {
  const seen = new Set<LibraryImportCsvColumn>()
  const duplicateColumns = new Set<LibraryImportCsvColumn>()
  const unknownColumnPositions: number[] = []

  actual.forEach((name, index) => {
    const column = libraryImportCsvColumnSchema.safeParse(name)

    if (!column.success) {
      unknownColumnPositions.push(index + 1)
    } else if (seen.has(column.data)) {
      duplicateColumns.add(column.data)
    } else {
      seen.add(column.data)
    }
  })

  return {
    reason: 'HEADER_MISMATCH',
    missingColumns: LIBRARY_IMPORT_CSV_HEADER.filter((column) => !seen.has(column)),
    duplicateColumns: [...duplicateColumns],
    unknownColumnPositions,
    orderMismatch: actual.some((name, index) => name !== LIBRARY_IMPORT_CSV_HEADER[index]),
  }
}

function isExactHeader(record: readonly string[]): boolean {
  return (
    record.length === LIBRARY_IMPORT_CSV_HEADER.length &&
    record.every((name, index) => name === LIBRARY_IMPORT_CSV_HEADER[index])
  )
}

function toCells(record: readonly string[]): LibraryImportCsvCells {
  // `relax_column_count: false` already guarantees the header's length once
  // the header itself matched; the schema turns that guarantee into a type.
  return libraryImportCsvCellsSchema.parse(
    Object.fromEntries(LIBRARY_IMPORT_CSV_HEADER.map((column, index) => [column, record[index]])),
  )
}

/**
 * Exported since 8f-2: an edited row re-parses through the same cell schemas as
 * a file, so its failures must map to the same per-column errors.
 */
export function libraryImportFieldErrors(
  issues: readonly { path: readonly PropertyKey[] }[],
): LibraryImportRowError[] {
  const failed = new Set(issues.map((issue) => issue.path[0]))

  return LIBRARY_IMPORT_CSV_HEADER.filter((column) => failed.has(column)).map((column) =>
    column === 'isbn13'
      ? { code: 'INVALID_ISBN', field: 'isbn13' }
      : { code: 'INVALID_FIELD', field: column },
  )
}

/**
 * Agreed rule: every normalized value except `quantity`, in header order.
 * Author order is part of the key; nothing beyond the shared schemas is
 * normalized.
 *
 * Exported since 8f-2: an edit can create or clear a duplicate, so the whole
 * draft is re-keyed after every PATCH with exactly this function — a second
 * implementation would flag different rows than the file did.
 */
export function libraryImportDuplicateKey(values: LibraryImportRowValues): string {
  return JSON.stringify(
    LIBRARY_IMPORT_CSV_HEADER.filter((column) => column !== 'quantity').map(
      (column) => values[LIBRARY_IMPORT_COLUMN_VALUE_KEYS[column]] ?? null,
    ),
  )
}

function toRows(records: readonly string[][]): LibraryImportParsedRow[] {
  const firstRowByKey = new Map<string, number>()

  return records.map((record, index) => {
    const rowNumber = index + 1
    const cells = toCells(record)
    const parsed = libraryImportCsvRowSchema.safeParse(cells)

    if (!parsed.success) {
      return {
        rowNumber,
        payload: {
          cells,
          values: null,
          errors: libraryImportFieldErrors(parsed.error.issues),
          resolution: null,
        },
      }
    }

    const key = libraryImportDuplicateKey(parsed.data)
    const firstRowNumber = firstRowByKey.get(key)
    const errors: LibraryImportRowError[] = []

    if (firstRowNumber === undefined) {
      firstRowByKey.set(key, rowNumber)
    } else {
      errors.push({ code: 'DUPLICATE_ROW', firstRowNumber })
    }

    // 8f-2 resolves rows; parsing only ever produces an unresolved payload.
    return { rowNumber, payload: { cells, values: parsed.data, errors, resolution: null } }
  })
}

/**
 * Agreed rule: valid quantities of ALL rows, duplicates and rows with other
 * field errors included; an empty cell counts as 1; an invalid quantity is not
 * replaced by 1 and adds nothing. Passing this cap does not make a file ready
 * to commit — 8g re-checks against the rows actually committed.
 */
function countCopies(rows: readonly LibraryImportParsedRow[]): number {
  return rows.reduce((sum, row) => {
    const quantity = libraryImportQuantityCellSchema.safeParse(row.payload.cells.quantity)

    return quantity.success ? sum + quantity.data : sum
  }, 0)
}

function isFailure<T>(value: T | Failure): value is Failure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false
}

export function parseLibraryImportCsv(input: Uint8Array): LibraryImportCsvParseResult {
  if (input.byteLength > LIBRARY_IMPORT_LIMITS.maxBytes) {
    return tooLarge({
      limit: 'BYTES',
      max: LIBRARY_IMPORT_LIMITS.maxBytes,
      actual: input.byteLength,
    })
  }

  const content = stripOneBom(input)
  const text = decodeUtf8(content)

  if (text === undefined) return invalidCsv({ reason: 'INVALID_ENCODING' })

  const delimiter = detectDelimiter(text)

  if (isFailure(delimiter)) return delimiter

  const records = readRecords(text, delimiter)

  if (isFailure(records)) return records

  const [header = [], ...data] = records

  if (!isExactHeader(header)) return invalidCsv(headerMismatch(header))

  if (data.length === 0) {
    return invalidCsv({ reason: 'EMPTY', delimiter, header: [...LIBRARY_IMPORT_CSV_HEADER] })
  }

  if (data.length > LIBRARY_IMPORT_LIMITS.maxDataRows) {
    return tooLarge({
      limit: 'ROWS',
      max: LIBRARY_IMPORT_LIMITS.maxDataRows,
      actual: data.length,
    })
  }

  const rows = toRows(data)
  const copyCount = countCopies(rows)

  if (copyCount > LIBRARY_IMPORT_LIMITS.maxCopies) {
    return tooLarge({ limit: 'COPIES', max: LIBRARY_IMPORT_LIMITS.maxCopies, actual: copyCount })
  }

  const sourceHash = createHash('sha256').update(content).digest('hex')

  return { ok: true, delimiter, sourceHash, rows, copyCount }
}
