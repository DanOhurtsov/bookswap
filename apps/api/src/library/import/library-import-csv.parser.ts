import { createHash } from 'node:crypto'
import { CsvError, parse } from 'csv-parse/sync'
import {
  API_ERROR_CODES,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  libraryImportCsvCellsSchema,
  type LibraryImportCsvCells,
  type LibraryImportDelimiter,
  type LibraryImportInvalidCsvDetails,
  type LibraryImportTooLargeDetails,
} from '@bookswap/shared'
import {
  buildLibraryImportRows,
  countLibraryImportCopies,
  isLibraryImportHeader,
  libraryImportHeaderMismatch,
  type LibraryImportParsedRow,
} from './library-import-rows'

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
  return { reason: 'HEADER_MISMATCH', ...libraryImportHeaderMismatch(actual) }
}

function toCells(record: readonly string[]): LibraryImportCsvCells {
  // `relax_column_count: false` already guarantees the header's length once
  // the header itself matched; the schema turns that guarantee into a type.
  return libraryImportCsvCellsSchema.parse(
    Object.fromEntries(LIBRARY_IMPORT_CSV_HEADER.map((column, index) => [column, record[index]])),
  )
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

  if (!isLibraryImportHeader(header)) return invalidCsv(headerMismatch(header))

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

  const rows = buildLibraryImportRows(data.map(toCells))
  const copyCount = countLibraryImportCopies(rows)

  if (copyCount > LIBRARY_IMPORT_LIMITS.maxCopies) {
    return tooLarge({ limit: 'COPIES', max: LIBRARY_IMPORT_LIMITS.maxCopies, actual: copyCount })
  }

  const sourceHash = createHash('sha256').update(content).digest('hex')

  return { ok: true, delimiter, sourceHash, rows, copyCount }
}
