import { Workbook } from 'exceljs'
import { LIBRARY_IMPORT_LIMITS, LIBRARY_IMPORT_XLSX_LIMITS } from '@bookswap/shared'
import { inspectWorkbookStructure } from './library-import-ooxml'
import { readLibraryImportXlsx } from './library-import-xlsx.reader'
import { xlsxDataRow, xlsxWorkbook } from './library-import-xlsx.test-helpers'
import { buildZip } from './library-import-zip.test-helpers'
import { readXlsxContainer } from './library-import-zip'

/**
 * The structural limits, and the one property that makes them worth having:
 * they are decided from the markup, before `Workbook.xlsx.load()` is asked to
 * build anything.
 *
 * `load()` materialises the whole workbook in a single call, so a cap checked
 * after it has already been paid in full. Several tests here therefore assert
 * not only the refusal but that ExcelJS was never called at all.
 */

const encode = (xml: string): Uint8Array => new TextEncoder().encode(xml)

function workbookXml(sheets: number): Uint8Array {
  const entries = Array.from(
    { length: sheets },
    (_unused, index) => `<sheet name="S${String(index)}" sheetId="${String(index + 1)}"/>`,
  ).join('')

  return encode(`<workbook><sheets>${entries}</sheets></workbook>`)
}

function sheetXml(rows: string): Uint8Array {
  return encode(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)
}

/** Rows of `cells` populated cells each, with honest references. */
function rowsXml(count: number, cells: number): string {
  return Array.from({ length: count }, (_unused, row) => {
    const columns = Array.from(
      { length: cells },
      (_ignored, cell) => `<c r="${String.fromCharCode(65 + cell)}${String(row + 1)}"/>`,
    ).join('')

    return `<row r="${String(row + 1)}">${columns}</row>`
  }).join('')
}

function craftedWorkbook(input: { sheets?: number; rows: string }): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', data: encode('<Types/>') },
    { name: 'xl/workbook.xml', data: workbookXml(input.sheets ?? 1) },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(input.rows) },
  ])
}

async function partsOf(file: Uint8Array): Promise<ReadonlyMap<string, Uint8Array>> {
  const container = await readXlsxContainer(file)

  if (!container.ok) throw new Error('expected a readable container')

  return container.parts
}

function failureOf(parts: ReadonlyMap<string, Uint8Array>): string {
  const result = inspectWorkbookStructure(parts)

  if (result === undefined) throw new Error('expected a refusal')

  return result.error.code === 'IMPORT_TOO_LARGE'
    ? `TOO_LARGE:${result.error.details.limit}`
    : result.error.details.reason
}

describe('structural limits, read from the markup', () => {
  it('refuses more sheets than allowed, counting the real total', async () => {
    const sheets = LIBRARY_IMPORT_XLSX_LIMITS.maxSheets + 3
    const parts = await partsOf(craftedWorkbook({ sheets, rows: rowsXml(1, 1) }))
    const result = inspectWorkbookStructure(parts)

    expect(result?.error.details).toEqual({
      limit: 'SHEETS',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxSheets,
      actual: sheets,
    })
  })

  it('refuses more populated cells than allowed', async () => {
    // One row is enough to carry them: the cap is on cells, not on rows.
    const cells = LIBRARY_IMPORT_XLSX_LIMITS.maxCells + 1
    const row = `<row r="1">${'<c/>'.repeat(cells)}</row>`

    expect(failureOf(await partsOf(craftedWorkbook({ rows: row })))).toBe('TOO_LARGE:CELLS')
  })

  /**
   * The limit counts `<row>` ELEMENTS, empty ones included — not books, not a
   * row index. Both sides of the boundary are pinned, because a cap that is
   * off by one either refuses a legal file or lets the next one through.
   */
  describe('the `<row>` element budget', () => {
    const { maxSheetRows } = LIBRARY_IMPORT_XLSX_LIMITS

    it('accepts a sheet holding exactly the allowed number of empty rows', async () => {
      const rows = `<row/>`.repeat(maxSheetRows)

      expect(inspectWorkbookStructure(await partsOf(craftedWorkbook({ rows })))).toBeUndefined()
    })

    it('refuses one empty row past the limit', async () => {
      // The hole a cell cap alone leaves: empty rows hold no cells and still
      // become objects the moment the workbook is built.
      const parts = await partsOf(craftedWorkbook({ rows: `<row/>`.repeat(maxSheetRows + 1) }))

      expect(inspectWorkbookStructure(parts)?.error.details).toEqual({
        limit: 'SHEET_ROWS',
        max: maxSheetRows,
        actual: maxSheetRows + 1,
      })
    })

    it('counts populated and empty rows alike', async () => {
      // Half of them carry a cell, half are bare: the budget makes no
      // distinction, because the reader builds an object for either.
      const populated = rowsXml(maxSheetRows / 2, 1)
      const empty = `<row/>`.repeat(maxSheetRows / 2 + 1)

      expect(failureOf(await partsOf(craftedWorkbook({ rows: populated + empty })))).toBe(
        'TOO_LARGE:SHEET_ROWS',
      )
    })

    it('does not mistake the row budget for the 200-book product limit', async () => {
      // Well past 200 data rows and well under the element budget: this is a
      // structural check, and the product cap is answered elsewhere, on rows
      // that actually carry books.
      const parts = await partsOf(craftedWorkbook({ rows: rowsXml(1_000, 1) }))

      expect(inspectWorkbookStructure(parts)).toBeUndefined()
    })
  })

  it.each([
    ['a row beyond Excel’s last row', '<row r="1048577"><c r="A1"/></row>'],
    ['a row index that is not a number', '<row r="10e9"><c r="A1"/></row>'],
    ['a cell beyond the last column', '<row r="1"><c r="XFE1"/></row>'],
    ['a cell reference of no known shape', '<row r="1"><c r="../../etc"/></row>'],
  ])('refuses %s', async (_name, rows) => {
    expect(failureOf(await partsOf(craftedWorkbook({ rows })))).toBe('MALFORMED_XLSX')
  })

  it('ignores a vast declared dimension instead of walking it', async () => {
    // The rectangle is a claim, not a fact. Three real cells cost three cells.
    const sheet = encode(
      `<worksheet><dimension ref="A1:XFD1048576"/><sheetData>${rowsXml(1, 3)}</sheetData></worksheet>`,
    )
    const file = buildZip([
      { name: '[Content_Types].xml', data: encode('<Types/>') },
      { name: 'xl/workbook.xml', data: workbookXml(1) },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ])

    expect(inspectWorkbookStructure(await partsOf(file))).toBeUndefined()
  })

  it('accepts a real full-size workbook of 200 rows', async () => {
    const rows = Array.from({ length: LIBRARY_IMPORT_LIMITS.maxDataRows }, (_unused, index) =>
      xlsxDataRow({ title: `Книжка ${String(index)}` }),
    )

    expect(inspectWorkbookStructure(await partsOf(await xlsxWorkbook(rows)))).toBeUndefined()
  })
})

describe('ExcelJS is never asked to build what the limits already refused', () => {
  let oversized: Uint8Array
  let ordinary: Uint8Array

  beforeAll(async () => {
    oversized = craftedWorkbook({
      rows: `<row/>`.repeat(LIBRARY_IMPORT_XLSX_LIMITS.maxSheetRows + 1),
    })
    // Built before any spy is installed — writing a workbook needs the real accessor.
    ordinary = await xlsxWorkbook([xlsxDataRow()])
  })

  function spyOnLoad(): jest.Mock {
    const load = jest.fn()

    jest.spyOn(Workbook.prototype, 'xlsx', 'get').mockReturnValue({ load } as never)

    return load
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('does not call load for a workbook past a structural limit', async () => {
    const load = spyOnLoad()
    const result = await readLibraryImportXlsx(oversized)

    expect(result.ok).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  /**
   * The control that keeps the assertion above from passing for the wrong
   * reason: the same spy, on a file that IS allowed through, must see the call.
   * Without this, a reader that never called ExcelJS at all would look correct.
   */
  it('does call load for a workbook within every limit', async () => {
    const load = spyOnLoad()

    await readLibraryImportXlsx(ordinary)

    expect(load).toHaveBeenCalledTimes(1)
  })
})
