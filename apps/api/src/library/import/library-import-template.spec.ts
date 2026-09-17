import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LIBRARY_IMPORT_CSV_HEADER } from '@bookswap/shared'
import { parseLibraryImportCsv } from './library-import-csv.parser'
import { csvLine, dataRow } from './library-import-csv.test-helpers'

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
