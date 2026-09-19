import { ValueType, type Cell, type CellValue } from 'exceljs'
import type { LibraryImportCellRejection, LibraryImportCsvColumn } from '@bookswap/shared'

/**
 * Stage 8f-4: one spreadsheet cell → one raw CSV cell.
 *
 * This is the whole of the XLSX-specific data handling. Everything past it —
 * field validation, defaults, duplicates, resolution — is the shared import
 * logic a CSV goes through, unchanged and unaware of where the strings came
 * from. So the rule here is narrow: produce the text the person actually typed,
 * and refuse rather than invent when that is not possible.
 */

export type XlsxCellRead =
  /** The cell as text, to be judged by the shared field schema like any CSV cell. */
  | { kind: 'text'; text: string }
  /**
   * Held something this column cannot take, and nothing honest can be written
   * in its place. The reason travels with the row and is stored there: an empty
   * cell alone would read as "not given" and take the column's default later.
   */
  | { kind: 'rejected'; reason: LibraryImportCellRejection }
  /** The file is refused outright: we will not run or trust this cell. */
  | { kind: 'file'; reason: 'FORMULA_CELL' | 'CELL_ERROR' }

/**
 * Serial 61 — 1900-03-01.
 *
 * Below it lies Excel's 1900 leap-year fiction, where its own numbering and
 * every correct conversion differ by a day. An `acquired_at` down there is a
 * mistake in the file, and answering it with a date that is off by one would
 * be worse than saying so.
 */
const EARLIEST_DATE = Date.UTC(1900, 2, 1)

/** Past this, `String(n)` switches to exponent notation, which is not what anyone typed. */
const PLAIN_NUMBER_LIMIT = 1e21

/**
 * `'header'` reads a cell of the header row, where no column rule applies yet:
 * a number or a date there is simply not one of the 22 names, and the header
 * check says so. Formulas and error cells still refuse the file.
 */
export type XlsxCellColumn = LibraryImportCsvColumn | 'header'

export function readXlsxCell(cell: Cell, column: XlsxCellColumn): XlsxCellRead {
  switch (cell.type) {
    // Neither the formula nor its cached result is read. The result is the
    // value of a computation we refuse to perform, and treating it as data
    // would import a number whose meaning we never established.
    case ValueType.Formula:
      return { kind: 'file', reason: 'FORMULA_CELL' }
    case ValueType.Error:
      return { kind: 'file', reason: 'CELL_ERROR' }
    case ValueType.Number:
      return readNumber(cell.value, column)
    case ValueType.Date:
      return readDate(cell.value, column)
    default:
      return { kind: 'text', text: readText(cell.value) }
  }
}

/**
 * A date is only ever a date in `acquired_at`.
 *
 * Anywhere else the person meant something else, and a serial number rendered
 * into a neighbouring column is the kind of silent corruption an import is
 * supposed to prevent — so that row is flagged instead.
 *
 * The conversion goes through UTC end to end: ExcelJS builds the `Date` from
 * the serial as a UTC instant, so reading it back with local getters would
 * shift the day for anyone west of Greenwich.
 */
function readDate(value: CellValue, column: XlsxCellColumn): XlsxCellRead {
  if (column !== 'acquired_at' || !(value instanceof Date)) {
    return { kind: 'rejected', reason: 'UNEXPECTED_DATE' }
  }

  const time = value.getTime()

  if (!Number.isFinite(time) || time < EARLIEST_DATE) {
    return { kind: 'rejected', reason: 'DATE_OUT_OF_RANGE' }
  }

  return { kind: 'text', text: value.toISOString().slice(0, 10) }
}

/**
 * Numbers are rendered, never interpreted.
 *
 * `isbn13` is the one column that gets a stricter rule, because Excel loves to
 * turn an ISBN into a float: an integer that survived exactly is written out
 * as its digits, and anything else is refused. It is never padded back to
 * thirteen digits and never expanded from exponent notation — a damaged ISBN
 * has to look damaged, not plausible.
 */
function readNumber(value: CellValue, column: XlsxCellColumn): XlsxCellRead {
  const unrepresentable: XlsxCellRead = { kind: 'rejected', reason: 'UNREPRESENTABLE_NUMBER' }

  if (typeof value !== 'number' || !Number.isFinite(value)) return unrepresentable
  if (Math.abs(value) >= PLAIN_NUMBER_LIMIT) return unrepresentable

  if (column === 'isbn13') {
    return Number.isSafeInteger(value) && value >= 0
      ? { kind: 'text', text: String(value) }
      : unrepresentable
  }

  // Every other column is judged by its own shared schema afterwards: `1.5`
  // fails an integer column and is perfectly good text in a title.
  return { kind: 'text', text: String(value) }
}

/** Text-ish cells, including the two shapes that carry text beside something else. */
function readText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)

  if (isRichText(value)) return value.richText.map((run) => run.text).join('')
  // A hyperlink's text is the data; its target is decoration the person did
  // not type into the column.
  if (isHyperlink(value)) return value.text

  return ''
}

function isRichText(value: object): value is { richText: { text: string }[] } {
  return 'richText' in value && Array.isArray(value.richText)
}

function isHyperlink(value: object): value is { text: string } {
  return 'text' in value && typeof value.text === 'string'
}
