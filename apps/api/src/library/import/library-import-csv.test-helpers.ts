import {
  LIBRARY_IMPORT_CSV_HEADER,
  type LibraryImportCsvCells,
  type LibraryImportDelimiter,
} from '@bookswap/shared'

/** Test-only builders for CSV import files; not used by production code. */

export const VALID_ISBN = '9780306406157'
export const OTHER_VALID_ISBN = '9780262033848'

export interface CsvFileOptions {
  delimiter?: LibraryImportDelimiter
  eol?: string
  bom?: boolean
}

const QUOTE_TRIGGER = /[",;\r\n]/

function quote(value: string): string {
  return QUOTE_TRIGGER.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function csvLine(
  fields: readonly string[],
  delimiter: LibraryImportDelimiter = ',',
): string {
  return fields.map(quote).join(delimiter)
}

export function dataRow(cells: Partial<LibraryImportCsvCells> = {}): string[] {
  return LIBRARY_IMPORT_CSV_HEADER.map((column) =>
    column === 'isbn13' ? (cells.isbn13 ?? VALID_ISBN) : (cells[column] ?? ''),
  )
}

export function csvText(
  rows: readonly (readonly string[])[],
  options: CsvFileOptions = {},
): string {
  const { delimiter = ',', eol = '\n' } = options

  return [LIBRARY_IMPORT_CSV_HEADER, ...rows].map((row) => csvLine(row, delimiter)).join(eol) + eol
}

export function toBytes(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text)

  return bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body
}

export function csvFile(
  rows: readonly (readonly string[])[],
  options: CsvFileOptions = {},
): Uint8Array {
  return toBytes(csvText(rows, options), options.bom)
}
