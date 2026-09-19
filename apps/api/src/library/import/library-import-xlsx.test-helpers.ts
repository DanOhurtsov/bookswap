import { Workbook, type Worksheet } from 'exceljs'
import { LIBRARY_IMPORT_CSV_HEADER } from '@bookswap/shared'
import { VALID_ISBN } from './library-import-csv.test-helpers'

/** Test-only builders for XLSX import files; not used by production code. */

/** What one spreadsheet cell holds — the raw ExcelJS value, not a string. */
export type XlsxCellValue = string | number | boolean | Date | null | undefined

export interface XlsxSheetSpec {
  name?: string
  /** Rows exactly as given, header included — nothing is added for you. */
  rows: readonly (readonly XlsxCellValue[])[]
}

/** The header row as the template writes it: 22 text cells in contract order. */
export function headerRow(): string[] {
  return [...LIBRARY_IMPORT_CSV_HEADER]
}

/** One data row, valid by default, with named overrides by column. */
export function xlsxDataRow(
  cells: Partial<Record<(typeof LIBRARY_IMPORT_CSV_HEADER)[number], XlsxCellValue>> = {},
): XlsxCellValue[] {
  return LIBRARY_IMPORT_CSV_HEADER.map((column) => {
    if (column in cells) return cells[column]

    return column === 'isbn13' ? VALID_ISBN : ''
  })
}

function fill(sheet: Worksheet, rows: readonly (readonly XlsxCellValue[])[]): void {
  rows.forEach((cells, index) => {
    const row = sheet.getRow(index + 1)

    cells.forEach((value, column) => {
      if (value !== undefined) row.getCell(column + 1).value = value
    })

    row.commit()
  })
}

export async function xlsxFile(sheets: readonly XlsxSheetSpec[]): Promise<Uint8Array> {
  const workbook = new Workbook()

  sheets.forEach((spec, index) => {
    fill(workbook.addWorksheet(spec.name ?? `Sheet${String(index + 1)}`), spec.rows)
  })

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** The common case: one sheet, the contract header, then the given data rows. */
export function xlsxWorkbook(
  rows: readonly (readonly XlsxCellValue[])[] = [xlsxDataRow()],
): Promise<Uint8Array> {
  return xlsxFile([{ rows: [headerRow(), ...rows] }])
}
