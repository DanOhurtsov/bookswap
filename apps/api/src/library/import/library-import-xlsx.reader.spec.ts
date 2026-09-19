import { Workbook } from 'exceljs'
import {
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  LIBRARY_IMPORT_XLSX_LIMITS,
  libraryImportInvalidXlsxDetailsSchema,
  libraryImportRowPayloadSchema,
  type LibraryImportCsvCells,
  type LibraryImportRowValues,
} from '@bookswap/shared'
import { parseLibraryImportCsv } from './library-import-csv.parser'
import { OTHER_VALID_ISBN, VALID_ISBN, csvFile, dataRow } from './library-import-csv.test-helpers'
import { readLibraryImportXlsx } from './library-import-xlsx.reader'
import {
  headerRow,
  xlsxDataRow,
  xlsxFile,
  xlsxWorkbook,
  type XlsxCellValue,
} from './library-import-xlsx.test-helpers'

/**
 * The workbook reader, judged on one question throughout: does an `.xlsx` end
 * up as exactly the rows the same data in a CSV would have produced?
 *
 * Where it cannot, the file or the row has to say so — a spreadsheet's extra
 * freedom over a text file (types, formulas, several sheets) must never turn
 * into a value nobody typed.
 */

async function readOk(
  file: Uint8Array,
): Promise<{ cells: LibraryImportCsvCells; values: LibraryImportRowValues | null }[]> {
  const result = await readLibraryImportXlsx(file)

  if (!result.ok) throw new Error(`expected a readable workbook, got ${result.error.code}`)

  return result.rows.map((row) => ({ cells: row.payload.cells, values: row.payload.values }))
}

async function failureOf(file: Uint8Array): Promise<string> {
  const result = await readLibraryImportXlsx(file)

  if (result.ok) throw new Error('expected a refusal')

  if (result.error.code === 'IMPORT_TOO_LARGE') return `TOO_LARGE:${result.error.details.limit}`

  expect(libraryImportInvalidXlsxDetailsSchema.safeParse(result.error.details).success).toBe(true)

  return result.error.details.reason
}

async function cellOf(value: XlsxCellValue, column: string): Promise<string | undefined> {
  const [row] = await readOk(await xlsxWorkbook([xlsxDataRow({ [column]: value })]))

  return row?.cells[column as keyof LibraryImportCsvCells]
}

async function errorsOf(value: XlsxCellValue, column: string): Promise<string[]> {
  const result = await readLibraryImportXlsx(await xlsxWorkbook([xlsxDataRow({ [column]: value })]))

  if (!result.ok) throw new Error('expected a readable workbook')

  return (result.rows[0]?.payload.errors ?? []).map((error) => error.code)
}

describe('the same data in either format', () => {
  it('produces identical rows from a CSV and a workbook', async () => {
    const cells: Partial<LibraryImportCsvCells> = {
      isbn13: VALID_ISBN,
      title: 'Дюна',
      authors: 'Френк Герберт|Пол Атрід',
      orig_lang: 'en',
      first_pub_year: '1965',
      edition_lang: 'uk',
      translator: 'Анатолій Пітик',
      translation_source_lang: 'en',
      translation_year: '2021',
      is_abridged: 'false',
      has_notes: 'true',
      publisher: 'Клуб сімейного дозвілля',
      edition_year: '2021',
      page_count: '656',
      format: 'HARDCOVER',
      condition: 'GOOD',
      visibility: 'FRIENDS',
      note: 'Друге видання',
      acquired_at: '2024-05-01',
      quantity: '2',
    }

    const csv = parseLibraryImportCsv(csvFile([dataRow(cells)]))
    const xlsx = await readLibraryImportXlsx(
      await xlsxWorkbook([LIBRARY_IMPORT_CSV_HEADER.map((column) => cells[column] ?? '')]),
    )

    expect(csv.ok && xlsx.ok).toBe(true)
    if (!csv.ok || !xlsx.ok) return

    expect(xlsx.rows).toEqual(csv.rows)
    expect(xlsx.copyCount).toBe(csv.copyCount)
    // Same books, different files: the two must not collapse into one import.
    expect(xlsx.sourceHash).not.toBe(csv.sourceHash)
  })

  it('flags a repeated row in a workbook exactly as a CSV does', async () => {
    const rows = await readLibraryImportXlsx(
      await xlsxWorkbook([xlsxDataRow(), xlsxDataRow(), xlsxDataRow({ isbn13: OTHER_VALID_ISBN })]),
    )

    expect(rows.ok).toBe(true)
    if (!rows.ok) return

    expect(rows.rows.map((row) => row.payload.errors)).toEqual([
      [],
      [{ code: 'DUPLICATE_ROW', firstRowNumber: 1 }],
      [],
    ])
  })
})

describe('cell types', () => {
  it('keeps Unicode text exactly as typed', async () => {
    expect(await cellOf('Шантарам — «том» 1', 'title')).toBe('Шантарам — «том» 1')
  })

  it('reads a numeric ISBN without padding or rounding it into something plausible', async () => {
    expect(await cellOf(Number(VALID_ISBN), 'isbn13')).toBe(VALID_ISBN)
  })

  it('shows a damaged ISBN as the digits it really is, and calls it invalid', async () => {
    // What Excel leaves behind after storing an ISBN as 9.78E+12. The number
    // survived as an exact integer, so it is written out unchanged and fails
    // its checksum. Padding it back to thirteen digits would invent an ISBN
    // belonging to some other edition, and hiding it would leave the owner
    // guessing what went wrong with a row they can plainly see.
    expect(await cellOf(9.78e12, 'isbn13')).toBe('9780000000000')
    expect(await errorsOf(9.78e12, 'isbn13')).toEqual(['INVALID_ISBN'])
  })

  it('refuses an ISBN that is not a whole number at all', async () => {
    expect(await cellOf(9780306406157.5, 'isbn13')).toBe('')
    expect(await errorsOf(9780306406157.5, 'isbn13')).toEqual(['INVALID_ISBN'])
  })

  it('renders an integer without exponent notation', async () => {
    expect(await cellOf(1965, 'first_pub_year')).toBe('1965')
  })

  it('reads a boolean as the only spelling the contract accepts', async () => {
    expect(await cellOf(true, 'is_abridged')).toBe('true')
    expect(await cellOf(false, 'has_notes')).toBe('false')
  })

  it('treats an empty and a missing cell alike, as "not given"', async () => {
    expect(await cellOf('', 'publisher')).toBe('')
    expect(await cellOf(null, 'publisher')).toBe('')
  })

  it('applies the shared defaults to empty cells, exactly as a CSV would', async () => {
    const [row] = await readOk(await xlsxWorkbook())

    expect(row?.values).toMatchObject({
      format: 'PAPERBACK',
      condition: 'GOOD',
      visibility: 'FRIENDS',
      quantity: 1,
    })
  })

  it('judges a fractional number by the column it sits in, not by being fractional', async () => {
    // Nothing about `1.5` is wrong in a title; it is wrong in a page count.
    expect(await cellOf(1.5, 'title')).toBe('1.5')
    expect(await errorsOf(1.5, 'title')).toEqual([])
    expect(await errorsOf(1.5, 'page_count')).toEqual(['INVALID_FIELD'])
  })
})

describe('dates', () => {
  it('converts an acquisition date to the contract format', async () => {
    expect(await cellOf(new Date(Date.UTC(2024, 4, 1)), 'acquired_at')).toBe('2024-05-01')
  })

  it('does not shift the day for a reader in another timezone', async () => {
    // The conversion is UTC end to end. Were it to touch local getters, this
    // is the case that would silently move every date back one day.
    const original = process.env.TZ

    try {
      process.env.TZ = 'America/Los_Angeles'
      expect(await cellOf(new Date(Date.UTC(2024, 0, 1)), 'acquired_at')).toBe('2024-01-01')
      process.env.TZ = 'Pacific/Kiritimati'
      expect(await cellOf(new Date(Date.UTC(2024, 0, 1)), 'acquired_at')).toBe('2024-01-01')
    } finally {
      process.env.TZ = original
    }
  })

  it('reads a workbook saved in the 1904 date system without a four-year shift', async () => {
    const workbook = new Workbook()

    workbook.properties.date1904 = true

    const sheet = workbook.addWorksheet('Sheet1')

    sheet.addRow(headerRow())
    sheet.addRow(
      LIBRARY_IMPORT_CSV_HEADER.map((column) => {
        if (column === 'isbn13') return VALID_ISBN

        return column === 'acquired_at' ? new Date(Date.UTC(2024, 4, 1)) : ''
      }),
    )

    const [row] = await readOk(new Uint8Array(await workbook.xlsx.writeBuffer()))

    expect(row?.cells.acquired_at).toBe('2024-05-01')
  })

  it('refuses a date inside Excel’s 1900 leap-year fiction rather than answering a day out', async () => {
    expect(await errorsOf(new Date(Date.UTC(1900, 0, 15)), 'acquired_at')).toEqual([
      'INVALID_FIELD',
    ])
  })

  it('flags a date sitting in a column that is not the acquisition date', async () => {
    // The alternative is writing a serial number, or a date, into a title —
    // a value the person never typed, imported without a word.
    expect(await errorsOf(new Date(Date.UTC(2024, 4, 1)), 'title')).toEqual(['INVALID_FIELD'])
    expect(await cellOf(new Date(Date.UTC(2024, 4, 1)), 'title')).toBe('')
  })
})

describe('a cell the reader refused', () => {
  it('leaves the row without values instead of letting the column default stand in', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxWorkbook([xlsxDataRow({ quantity: new Date(Date.UTC(2024, 4, 1)) })]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [row] = result.rows

    // `quantity` is empty because nothing honest could be written there, and an
    // empty quantity means 1. Accepting that would report a copy the file never
    // asked for, so the row carries no values at all.
    expect(row?.payload.values).toBeNull()
    expect(row?.payload.errors).toEqual([{ code: 'INVALID_FIELD', field: 'quantity' }])
  })

  it('records why the cell was refused, not merely that it was', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxWorkbook([
        xlsxDataRow({ quantity: new Date(Date.UTC(2024, 4, 1)), page_count: 1e22 }),
      ]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows[0]?.payload.rejectedCells).toEqual({
      quantity: 'UNEXPECTED_DATE',
      page_count: 'UNREPRESENTABLE_NUMBER',
    })
  })

  it('does not count a refused quantity as one copy', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxWorkbook([
        xlsxDataRow({ isbn13: VALID_ISBN, quantity: 3 }),
        xlsxDataRow({ isbn13: OTHER_VALID_ISBN, quantity: new Date(Date.UTC(2024, 4, 1)) }),
      ]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // R6a: an invalid quantity adds nothing. A refused cell is an invalid one.
    expect(result.copyCount).toBe(3)
  })

  it('marks an out-of-range acquisition date apart from a misplaced one', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxWorkbook([xlsxDataRow({ acquired_at: new Date(Date.UTC(1900, 0, 15)) })]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows[0]?.payload.rejectedCells).toEqual({ acquired_at: 'DATE_OUT_OF_RANGE' })
  })
})

describe('cells we refuse to read', () => {
  it('refuses a formula and does not fall back to its cached result', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet('Sheet1')

    sheet.addRow(headerRow())
    sheet.addRow(xlsxDataRow())
    sheet.getCell('B2').value = { formula: 'A2&""', result: 'Обчислена назва' }

    const file = new Uint8Array(await workbook.xlsx.writeBuffer())
    const result = await readLibraryImportXlsx(file)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.details).toEqual({
      reason: 'FORMULA_CELL',
      sheet: 1,
      row: 2,
      column: 2,
    })
  })

  it('reports an Excel error cell under its own reason, not as a formula', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet('Sheet1')

    sheet.addRow(headerRow())
    sheet.addRow(xlsxDataRow())
    sheet.getCell('A2').value = { error: '#REF!' }

    const file = new Uint8Array(await workbook.xlsx.writeBuffer())

    expect(await failureOf(file)).toBe('CELL_ERROR')
  })
})

describe('sheets', () => {
  it('refuses to choose when two sheets hold data', async () => {
    const file = await xlsxFile([
      { rows: [headerRow(), xlsxDataRow()] },
      { rows: [headerRow(), xlsxDataRow({ isbn13: OTHER_VALID_ISBN })] },
    ])
    const result = await readLibraryImportXlsx(file)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.details).toEqual({ reason: 'MULTIPLE_SHEETS', sheets: [1, 2] })
  })

  it('ignores a sheet that carries only formatting', async () => {
    const workbook = new Workbook()
    const data = workbook.addWorksheet('Books')

    data.addRow(headerRow())
    data.addRow(xlsxDataRow())

    // Styled but empty: a leftover from a template, not a second data sheet.
    const decorative = workbook.addWorksheet('Порожній')

    decorative.getCell('A1').style = { font: { bold: true } }
    decorative.getColumn(3).width = 40

    const rows = await readOk(new Uint8Array(await workbook.xlsx.writeBuffer()))

    expect(rows).toHaveLength(1)
  })

  it('refuses a workbook with no data at all', async () => {
    expect(await failureOf(await xlsxFile([{ rows: [] }]))).toBe('NO_SHEET')
  })

  it('reports a header-only sheet as empty, not as a header problem', async () => {
    expect(await failureOf(await xlsxFile([{ rows: [headerRow()] }]))).toBe('EMPTY')
  })

  it('skips a blank row between books instead of failing on it', async () => {
    const rows = await readOk(
      await xlsxWorkbook([
        xlsxDataRow(),
        Array.from({ length: 22 }, () => ''),
        xlsxDataRow({ isbn13: OTHER_VALID_ISBN }),
      ]),
    )

    expect(rows).toHaveLength(2)
  })
})

describe('the header', () => {
  it('refuses a renamed column and names the position, never the text', async () => {
    const header = headerRow()

    header[1] = 'назва'

    const result = await readLibraryImportXlsx(await xlsxFile([{ rows: [header, xlsxDataRow()] }]))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.details).toEqual({
      reason: 'HEADER_MISMATCH',
      sheet: 1,
      missingColumns: ['title'],
      duplicateColumns: [],
      unknownColumnPositions: [2],
      orderMismatch: true,
    })
    expect(JSON.stringify(result.error.details)).not.toContain('назва')
  })

  it('refuses reordered columns', async () => {
    const header = [...headerRow()]

    ;[header[1], header[2]] = [header[2] as string, header[1] as string]

    expect(await failureOf(await xlsxFile([{ rows: [header, xlsxDataRow()] }]))).toBe(
      'HEADER_MISMATCH',
    )
  })

  it('refuses data in a column beyond the contract instead of ignoring it', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxFile([{ rows: [headerRow(), [...xlsxDataRow(), 'щось іще']] }]),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.details).toMatchObject({
      reason: 'HEADER_MISMATCH',
      unknownColumnPositions: [23],
    })
  })
})

describe('limits', () => {
  it('accepts a full-size workbook of 200 rows', async () => {
    const rows = Array.from({ length: LIBRARY_IMPORT_LIMITS.maxDataRows }, (_unused, index) =>
      xlsxDataRow({ title: `Книжка ${String(index)}`, note: 'Приватна нотатка' }),
    )
    const file = await xlsxWorkbook(rows)

    // The agreed caps have to leave a realistic file comfortable room, not
    // just barely admit it.
    expect(file.byteLength).toBeLessThan(LIBRARY_IMPORT_XLSX_LIMITS.maxBytes / 4)
    expect(await readOk(file)).toHaveLength(LIBRARY_IMPORT_LIMITS.maxDataRows)
  })

  it('refuses one row past the limit', async () => {
    const rows = Array.from({ length: LIBRARY_IMPORT_LIMITS.maxDataRows + 1 }, (_unused, index) =>
      xlsxDataRow({ title: `Книжка ${String(index)}` }),
    )

    expect(await failureOf(await xlsxWorkbook(rows))).toBe('TOO_LARGE:ROWS')
  })

  it('refuses a file over the byte cap before opening it', async () => {
    const oversized = new Uint8Array(LIBRARY_IMPORT_XLSX_LIMITS.maxBytes + 1)

    expect(await failureOf(oversized)).toBe('TOO_LARGE:BYTES')
  })

  it('refuses more copies than the contract allows', async () => {
    const perRow = LIBRARY_IMPORT_LIMITS.quantityMax
    const count = Math.ceil(LIBRARY_IMPORT_LIMITS.maxCopies / perRow) + 1
    const rows = Array.from({ length: count }, (_unused, index) =>
      xlsxDataRow({ title: `Книжка ${String(index)}`, quantity: perRow }),
    )

    expect(await failureOf(await xlsxWorkbook(rows))).toBe('TOO_LARGE:COPIES')
  })
})

describe('what a draft may store', () => {
  it('produces payloads the persisted-row contract accepts', async () => {
    const result = await readLibraryImportXlsx(
      await xlsxWorkbook([xlsxDataRow(), xlsxDataRow({ isbn13: 'не ISBN' })]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    for (const row of result.rows) {
      expect(
        libraryImportRowPayloadSchema.safeParse({ ...row.payload, rowVersion: 'v1' }).success,
      ).toBe(true)
    }
  })
})
