import { Workbook } from 'exceljs'
import { LIBRARY_IMPORT_CSV_HEADER } from '@bookswap/shared'

/**
 * Stage 8f-4: the downloadable `.xlsx` template — a header row and nothing else.
 *
 * Header-only for the same reason the CSV template is (R6a): a demonstration
 * book in the file is a book somebody imports by accident. The worked example
 * belongs in the documentation, where it cannot be uploaded.
 *
 * The one thing this file has to get right beyond the header is the ISBN
 * column's format. Left to itself, Excel reads `9780306406157` as a number and
 * shows it as `9.78031E+12`; the digits usually survive, but a thirteen-digit
 * ISBN starting with a zero would lose it outright, and anything the reader
 * cannot verify it must refuse. Marking the column as text (`@`) means the
 * person's ISBNs stay strings from the moment they type them.
 */

/** Excel's built-in "Text" number format. */
const TEXT_FORMAT = '@'

const ISBN_COLUMN = LIBRARY_IMPORT_CSV_HEADER.indexOf('isbn13') + 1

const SHEET_NAME = 'Книжки'

export async function buildLibraryImportTemplate(): Promise<Uint8Array> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet(SHEET_NAME)

  sheet.addRow([...LIBRARY_IMPORT_CSV_HEADER]).font = { bold: true }

  // Applied to the column, so it also covers the empty cells the person is
  // about to fill in — not only the ones that already exist.
  const isbn = sheet.getColumn(ISBN_COLUMN)

  isbn.numFmt = TEXT_FORMAT
  isbn.width = 18

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
