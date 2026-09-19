import { createHash } from 'node:crypto'
import { Workbook, type Row, type Worksheet } from 'exceljs'
import {
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  LIBRARY_IMPORT_XLSX_HASH_PREFIX,
  LIBRARY_IMPORT_XLSX_LIMITS,
  libraryImportCsvCellsSchema,
  type LibraryImportCsvCells,
  type LibraryImportInvalidXlsxDetails,
  type LibraryImportRejectedCells,
} from '@bookswap/shared'
import {
  buildLibraryImportRows,
  countLibraryImportCopies,
  isLibraryImportHeader,
  libraryImportHeaderMismatch,
  type LibraryImportParsedRow,
} from './library-import-rows'
import { inspectWorkbookStructure } from './library-import-ooxml'
import { readXlsxCell } from './library-import-xlsx.cells'
import {
  invalidXlsx,
  isXlsxFailure,
  tooLargeXlsx,
  type LibraryImportXlsxError,
  type XlsxFailure,
} from './library-import-xlsx.errors'
import { readXlsxContainer } from './library-import-zip'

/**
 * Stage 8f-4: an `.xlsx` → exactly the rows a CSV would have produced.
 *
 * Every expected failure is a value, never an exception: nothing a person can
 * put in a workbook may crash the process. Nothing is logged, and no error
 * detail carries a cell's contents or a sheet's name — only positions.
 *
 * The workbook is never trusted about its own size. `dimension` and `rowCount`
 * describe a rectangle a file may claim to be a million rows tall while holding
 * three; every loop here walks only the rows and cells that actually exist.
 */

export type LibraryImportXlsxResult =
  | {
      ok: true
      /** R6 as amended for 8f-4: SHA-256 of the format prefix and the received bytes. */
      sourceHash: string
      rows: LibraryImportParsedRow[]
      copyCount: number
    }
  | { ok: false; error: LibraryImportXlsxError }

type Failure = XlsxFailure

const invalid = invalidXlsx
const tooLarge = tooLargeXlsx
const isFailure = isXlsxFailure

interface SheetScan {
  /** Rows that hold at least one value, in order — never every row of `dimension`. */
  rows: Row[]
  cells: number
  /** Populated columns beyond the 22 the contract defines, by 1-based position. */
  extraColumns: number[]
}

/** Walks only materialised rows and cells, so a sparse sheet costs what it holds. */
function scanSheet(sheet: Worksheet): SheetScan {
  const rows: Row[] = []
  const extra = new Set<number>()
  let cells = 0

  sheet.eachRow({ includeEmpty: false }, (row) => {
    let populated = 0

    row.eachCell({ includeEmpty: false }, (_cell, column) => {
      populated += 1

      if (column > LIBRARY_IMPORT_CSV_HEADER.length) extra.add(column)
    })

    if (populated === 0) return

    cells += populated
    rows.push(row)
  })

  return { rows, cells, extraColumns: [...extra].sort((a, b) => a - b) }
}

/** Reads the 22 contract columns of one row; a refusing cell stops the whole file. */
function readRow(
  row: Row,
  sheet: number,
): { cells: LibraryImportCsvCells; rejected: LibraryImportRejectedCells } | Failure {
  const values: Record<string, string> = {}
  const rejected: LibraryImportRejectedCells = {}

  for (const [index, column] of LIBRARY_IMPORT_CSV_HEADER.entries()) {
    const read = readXlsxCell(row.getCell(index + 1), column)

    if (read.kind === 'file') {
      return invalid({ reason: read.reason, sheet, row: row.number, column: index + 1 })
    }

    if (read.kind === 'rejected') {
      // No text is invented for it — the reason is what records what was here.
      rejected[column] = read.reason
      values[column] = ''
    } else {
      values[column] = read.text
    }
  }

  return { cells: libraryImportCsvCellsSchema.parse(values), rejected }
}

function readHeader(row: Row, sheet: number): LibraryImportInvalidXlsxDetails | undefined {
  const names: string[] = []

  for (let column = 1; column <= LIBRARY_IMPORT_CSV_HEADER.length; column += 1) {
    const read = readXlsxCell(row.getCell(column), 'header')

    if (read.kind === 'file') return { reason: read.reason, sheet, row: row.number, column }

    names.push(read.kind === 'text' ? read.text : '')
  }

  return isLibraryImportHeader(names)
    ? undefined
    : { reason: 'HEADER_MISMATCH', sheet, ...libraryImportHeaderMismatch(names) }
}

/** The header row, the data rows and the per-row columns the reader itself rejected. */
function readSheet(
  scan: SheetScan,
  sheet: number,
):
  | { records: LibraryImportCsvCells[]; rejections: Map<number, LibraryImportRejectedCells> }
  | Failure {
  const [header, ...rest] = scan.rows

  if (header === undefined) return invalid({ reason: 'NO_SHEET' })

  const mismatch = readHeader(header, sheet)

  if (mismatch !== undefined) return invalid(mismatch)

  const records: LibraryImportCsvCells[] = []
  const rejections = new Map<number, LibraryImportRejectedCells>()

  for (const row of rest) {
    const read = readRow(row, sheet)

    if (isFailure(read)) return read

    // A row of nothing but blanks is skipped exactly as an empty CSV line is
    // — but only when it really was blank. A row whose every cell the reader
    // refused (a single unusable ISBN and nothing else) also reads as all
    // empty, and dropping it would answer "the file has no books" to someone
    // looking straight at one.
    const rejectedColumns = Object.keys(read.rejected)
    const blank =
      rejectedColumns.length === 0 && Object.values(read.cells).every((cell) => cell === '')

    if (blank) continue

    records.push(read.cells)

    if (rejectedColumns.length > 0) rejections.set(records.length, read.rejected)
  }

  return { records, rejections }
}

/**
 * Which sheet holds the data — and a refusal when that is not exactly one.
 *
 * A sheet left over from a template, carrying only formatting, holds no cells
 * and is not a data sheet. When two really do hold data we ask rather than
 * choose: picking one silently, or merging them, would import a list nobody
 * reviewed (agreed 8f-4 decision).
 */
function selectSheet(workbook: Workbook): { sheet: number; scan: SheetScan } | Failure {
  const scans = workbook.worksheets.map((sheet) => scanSheet(sheet))
  const withData = scans.flatMap((scan, index) => (scan.cells > 0 ? [index + 1] : []))

  if (withData.length === 0) return invalid({ reason: 'NO_SHEET' })
  if (withData.length > 1) return invalid({ reason: 'MULTIPLE_SHEETS', sheets: withData })

  const sheet = withData[0] ?? 1
  const scan = scans[sheet - 1]

  if (scan === undefined) return invalid({ reason: 'MALFORMED_XLSX' })

  if (scan.cells > LIBRARY_IMPORT_XLSX_LIMITS.maxCells) {
    return tooLarge({
      limit: 'CELLS',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxCells,
      actual: scan.cells,
    })
  }

  if (scan.extraColumns.length > 0) {
    return invalid({
      reason: 'HEADER_MISMATCH',
      sheet,
      missingColumns: [],
      duplicateColumns: [],
      unknownColumnPositions: scan.extraColumns.slice(0, LIBRARY_IMPORT_CSV_HEADER.length),
      orderMismatch: false,
    })
  }

  return { sheet, scan }
}

/**
 * The only place ExcelJS is asked to build anything — reached only after the
 * markup has been measured and found within every structural limit.
 */
async function loadWorkbook(canonical: Uint8Array): Promise<Workbook | Failure> {
  const workbook = new Workbook()

  try {
    // An `ArrayBuffer`, not a Node `Buffer`: ExcelJS's own type declaration
    // opens with `declare interface Buffer extends ArrayBuffer {}`, so the
    // `Buffer` its signature names is that local interface and not Node's —
    // which extends `Uint8Array` and does not satisfy it. JSZip, what `load`
    // actually hands the bytes to, reads an `ArrayBuffer` natively.
    await workbook.xlsx.load(new Uint8Array(canonical).buffer)
  } catch {
    return invalid({ reason: 'MALFORMED_XLSX' })
  }

  return workbook
}

export async function readLibraryImportXlsx(input: Uint8Array): Promise<LibraryImportXlsxResult> {
  if (input.byteLength > LIBRARY_IMPORT_XLSX_LIMITS.maxBytes) {
    return tooLarge({
      limit: 'BYTES',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxBytes,
      actual: input.byteLength,
    })
  }

  const container = await readXlsxContainer(input)

  if (!container.ok) return container

  // Before `load()`, never after: sheets, rows, cells and cell references are
  // counted in the markup itself, so a workbook past any structural limit is
  // refused without ExcelJS being asked to materialise it.
  const structure = inspectWorkbookStructure(container.parts)

  if (structure !== undefined) return structure

  const workbook = await loadWorkbook(container.canonical)

  if (isFailure(workbook)) return workbook

  const selected = selectSheet(workbook)

  if (isFailure(selected)) return selected

  const read = readSheet(selected.scan, selected.sheet)

  if (isFailure(read)) return read

  return finish(read.records, read.rejections, input, selected.sheet)
}

/** The caps that can only be known once the rows are counted, then the hash. */
function finish(
  records: readonly LibraryImportCsvCells[],
  rejections: ReadonlyMap<number, LibraryImportRejectedCells>,
  input: Uint8Array,
  sheet: number,
): LibraryImportXlsxResult {
  if (records.length === 0) return invalid({ reason: 'EMPTY', sheet })

  if (records.length > LIBRARY_IMPORT_LIMITS.maxDataRows) {
    return tooLarge({
      limit: 'ROWS',
      max: LIBRARY_IMPORT_LIMITS.maxDataRows,
      actual: records.length,
    })
  }

  const rows = buildLibraryImportRows(records, rejections)
  const copyCount = countLibraryImportCopies(rows)

  if (copyCount > LIBRARY_IMPORT_LIMITS.maxCopies) {
    return tooLarge({ limit: 'COPIES', max: LIBRARY_IMPORT_LIMITS.maxCopies, actual: copyCount })
  }

  const sourceHash = createHash('sha256')
    .update(LIBRARY_IMPORT_XLSX_HASH_PREFIX)
    .update(input)
    .digest('hex')

  return { ok: true, sourceHash, rows, copyCount }
}
