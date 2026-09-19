import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Workbook } from 'exceljs'
import { LIBRARY_IMPORT_CSV_HEADER } from '@bookswap/shared'
import { parseLibraryImportCsv } from './library-import-csv.parser'
import { csvLine, dataRow } from './library-import-csv.test-helpers'
import { readLibraryImportXlsx } from './library-import-xlsx.reader'
import { xlsxDataRow } from './library-import-xlsx.test-helpers'

/**
 * R4 contract: the downloadable template served by the web app is read with the
 * very parser the API uses. The asset is listed in this package's Turbo `test`
 * inputs (turbo.json), so editing only the template re-runs this test.
 */
const TEMPLATE_PATH = resolve(__dirname, '../../../../web/public/library-import-template.csv')

describe('/library-import-template.csv', () => {
  const template = readFileSync(TEMPLATE_PATH)

  it('is a header-only file whose header is exactly the shared R4 header', () => {
    expect(parseLibraryImportCsv(template)).toEqual({
      ok: false,
      error: {
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'EMPTY', delimiter: ',', header: [...LIBRARY_IMPORT_CSV_HEADER] },
      },
    })
  })

  it('parses successfully once a valid data row is appended', () => {
    const withRow = Buffer.concat([template, Buffer.from(`${csvLine(dataRow())}\n`)])
    const result = parseLibraryImportCsv(withRow)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.payload.errors).toEqual([])
  })
})

/**
 * The same contract for the `.xlsx` template, read back with the production
 * reader rather than with ExcelJS directly: a binary asset cannot be reviewed
 * in a diff, so the only real guard is that the file a person downloads is one
 * this service would accept.
 */
const XLSX_TEMPLATE_PATH = resolve(__dirname, '../../../../web/public/library-import-template.xlsx')

describe('/library-import-template.xlsx', () => {
  const template = readFileSync(XLSX_TEMPLATE_PATH)

  it('is a header-only workbook whose one sheet matches the shared R4 header', async () => {
    expect(await readLibraryImportXlsx(template)).toEqual({
      ok: false,
      error: { code: 'IMPORT_INVALID_XLSX', details: { reason: 'EMPTY', sheet: 1 } },
    })
  })

  it('formats the ISBN column as text, so Excel cannot turn an ISBN into a float', async () => {
    const workbook = new Workbook()

    await workbook.xlsx.load(new Uint8Array(template).buffer)

    const sheet = workbook.worksheets[0]
    const isbnColumn = LIBRARY_IMPORT_CSV_HEADER.indexOf('isbn13') + 1

    expect(sheet?.getColumn(isbnColumn).numFmt).toBe('@')
  })

  it('reads a book back unchanged once a row is filled in', async () => {
    const workbook = new Workbook()

    await workbook.xlsx.load(new Uint8Array(template).buffer)
    workbook.worksheets[0]?.addRow(xlsxDataRow({ title: 'Дюна', quantity: 2 }))

    const result = await readLibraryImportXlsx(new Uint8Array(await workbook.xlsx.writeBuffer()))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.payload.errors).toEqual([])
    expect(result.rows[0]?.payload.values).toMatchObject({ title: 'Дюна', quantity: 2 })
  })
})
