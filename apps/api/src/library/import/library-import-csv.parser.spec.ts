import { createHash } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { LIBRARY_IMPORT_CSV_HEADER, LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import {
  parseLibraryImportCsv,
  type LibraryImportCsvParseResult,
  type LibraryImportParsedRow,
} from './library-import-csv.parser'
import {
  OTHER_VALID_ISBN,
  VALID_ISBN,
  csvFile,
  csvLine,
  csvText,
  dataRow,
  toBytes,
} from './library-import-csv.test-helpers'

function parseOk(input: Uint8Array): Extract<LibraryImportCsvParseResult, { ok: true }> {
  const result = parseLibraryImportCsv(input)

  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`)

  return result
}

function parseError(
  input: Uint8Array,
): Extract<LibraryImportCsvParseResult, { ok: false }>['error'] {
  const result = parseLibraryImportCsv(input)

  if (result.ok) throw new Error('Expected a file-level error')

  return result.error
}

function errorsOf(row: LibraryImportParsedRow | undefined): unknown[] {
  if (row === undefined) throw new Error('Row missing')

  return row.payload.errors
}

const HEADER_LINE = LIBRARY_IMPORT_CSV_HEADER.join(',')

describe('parseLibraryImportCsv', () => {
  describe('encoding and BOM', () => {
    it('parses a UTF-8 file with and without one leading BOM identically', () => {
      const rows = [dataRow({ title: 'Кобзар' })]
      const plain = parseOk(csvFile(rows))
      const withBom = parseOk(csvFile(rows, { bom: true }))

      expect(withBom.rows).toEqual(plain.rows)
      expect(withBom.sourceHash).toBe(plain.sourceHash)
    })

    it('strips the BOM exactly once: a double BOM is a header mismatch, not a valid header', () => {
      const bytes = toBytes(`\uFEFF${csvText([dataRow()])}`, true)

      expect(parseError(bytes)).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: {
          reason: 'HEADER_MISMATCH',
          missingColumns: ['isbn13'],
          duplicateColumns: [],
          unknownColumnPositions: [1],
          orderMismatch: true,
        },
      })
    })

    it('rejects invalid UTF-8 as INVALID_ENCODING', () => {
      const valid = csvFile([dataRow()])
      const broken = Uint8Array.from([...valid.subarray(0, valid.length - 1), 0xc3, 0x28, 0x0a])

      expect(parseError(broken)).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'INVALID_ENCODING' },
      })
    })

    it('keeps Cyrillic, emoji and 4-byte characters intact', () => {
      const [row] = parseOk(
        csvFile([dataRow({ title: 'Ґанок 𝔘 📚', authors: 'Леся Українка|Іван Франко' })]),
      ).rows

      expect(row?.payload.values).toMatchObject({
        title: 'Ґанок 𝔘 📚',
        authors: ['Леся Українка', 'Іван Франко'],
      })
    })
  })

  describe('delimiters', () => {
    it('accepts comma and semicolon, detected from the header', () => {
      const rows = [dataRow({ title: 'A, B; C' })]
      const comma = parseOk(csvFile(rows, { delimiter: ',' }))
      const semicolon = parseOk(csvFile(rows, { delimiter: ';' }))

      expect(comma.delimiter).toBe(',')
      expect(semicolon.delimiter).toBe(';')
      expect(semicolon.rows).toEqual(comma.rows)
    })

    it('rejects a header mixing both delimiters as AMBIGUOUS_DELIMITER', () => {
      const header = HEADER_LINE.replace('title,', 'title;')

      expect(parseError(toBytes(`${header}\n${csvLine(dataRow())}\n`))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'AMBIGUOUS_DELIMITER' },
      })
    })

    it('rejects comma data under a semicolon header as COLUMN_COUNT', () => {
      const header = LIBRARY_IMPORT_CSV_HEADER.join(';')

      expect(parseError(toBytes(`${header}\n${csvLine(dataRow())}\n`))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'COLUMN_COUNT', line: 2 },
      })
    })

    it('rejects a header with no delimiter at all as HEADER_MISMATCH', () => {
      const error = parseError(toBytes('isbn13\n9780306406157\n'))

      expect(error).toMatchObject({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'HEADER_MISMATCH', unknownColumnPositions: [] },
      })
    })
  })

  describe('RFC 4180 quoting and line endings', () => {
    it('handles quoted delimiters, escaped quotes and newlines inside quotes', () => {
      const note = 'Line one, "quoted"\r\nLine two; end\nLine three'
      const [row] = parseOk(csvFile([dataRow({ note, title: '"Кобзар"' })])).rows

      expect(row?.payload.cells.note).toBe(note)
      expect(row?.payload.values).toMatchObject({ note, title: '"Кобзар"' })
    })

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
      ['CR', '\r'],
    ])('accepts %s line endings', (_name, eol) => {
      expect(
        parseOk(csvFile([dataRow(), dataRow({ condition: 'WORN' })], { eol })).rows,
      ).toHaveLength(2)
    })

    it('accepts mixed line endings within one file', () => {
      const text = `${HEADER_LINE}\r\n${csvLine(dataRow())}\n${csvLine(dataRow({ condition: 'NEW' }))}\r`

      expect(parseOk(toBytes(text)).rows).toHaveLength(2)
    })

    it('skips empty lines and numbers rows by data record, not by physical line', () => {
      const text = `${HEADER_LINE}\n\n${csvLine(dataRow({ note: 'a\nb' }))}\n\n${csvLine(dataRow({ condition: 'NEW' }))}\n`
      const result = parseOk(toBytes(text))

      expect(result.rows.map((row) => row.rowNumber)).toEqual([1, 2])
    })

    it('reports an unclosed quote as MALFORMED_CSV', () => {
      const text = `${HEADER_LINE}\n"${csvLine(dataRow())}\n`

      expect(parseError(toBytes(text))).toMatchObject({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'MALFORMED_CSV' },
      })
    })

    it('reports a stray quote inside an unquoted field as MALFORMED_CSV', () => {
      const text = `${HEADER_LINE}\n${csvLine(dataRow()).replace(VALID_ISBN, `97803064"06157`)}\n`

      expect(parseError(toBytes(text))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'MALFORMED_CSV', line: 2 },
      })
    })

    it('reports a data row with too few or too many fields as COLUMN_COUNT with its line', () => {
      const short = `${HEADER_LINE}\n${csvLine(dataRow())}\n${VALID_ISBN},Title\n`
      const long = `${HEADER_LINE}\n${csvLine(dataRow())},extra\n`

      expect(parseError(toBytes(short))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'COLUMN_COUNT', line: 3 },
      })
      expect(parseError(toBytes(long))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'COLUMN_COUNT', line: 2 },
      })
    })
  })

  describe('header', () => {
    function headerError(header: readonly string[]): unknown {
      return parseError(toBytes(`${csvLine(header)}\n${csvLine(dataRow())}\n`))
    }

    it('reports unknown columns by position only, never by their text', () => {
      const header: string[] = [...LIBRARY_IMPORT_CSV_HEADER]
      header[1] = 'secret-title'
      const error = headerError(header)

      expect(error).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: {
          reason: 'HEADER_MISMATCH',
          missingColumns: ['title'],
          duplicateColumns: [],
          unknownColumnPositions: [2],
          orderMismatch: true,
        },
      })
      expect(JSON.stringify(error)).not.toContain('secret')
    })

    it('reports duplicate, missing, reordered and case-changed columns', () => {
      const duplicated = [...LIBRARY_IMPORT_CSV_HEADER]
      duplicated[1] = 'isbn13'

      expect(headerError(duplicated)).toMatchObject({
        details: { duplicateColumns: ['isbn13'], missingColumns: ['title'] },
      })

      const reordered = [...LIBRARY_IMPORT_CSV_HEADER]
      ;[reordered[0], reordered[1]] = ['title', 'isbn13']

      expect(headerError(reordered)).toMatchObject({
        details: {
          missingColumns: [],
          duplicateColumns: [],
          unknownColumnPositions: [],
          orderMismatch: true,
        },
      })

      const upper = LIBRARY_IMPORT_CSV_HEADER.map((column, index) =>
        index === 0 ? 'ISBN13' : column,
      )

      expect(headerError(upper)).toMatchObject({ details: { unknownColumnPositions: [1] } })

      const padded = LIBRARY_IMPORT_CSV_HEADER.map((column, index) =>
        index === 0 ? ' isbn13' : column,
      )

      expect(headerError(padded)).toMatchObject({ details: { unknownColumnPositions: [1] } })
    })

    it('rejects a missing trailing column and an extra trailing delimiter', () => {
      const missing = LIBRARY_IMPORT_CSV_HEADER.slice(0, -1)
      const missingText = `${csvLine(missing)}\n${csvLine(dataRow().slice(0, -1))}\n`

      expect(parseError(toBytes(missingText))).toMatchObject({
        details: { reason: 'HEADER_MISMATCH', missingColumns: ['quantity'], orderMismatch: false },
      })

      const extraText = `${HEADER_LINE},\n${csvLine(dataRow())},\n`

      expect(parseError(toBytes(extraText))).toMatchObject({
        details: { reason: 'HEADER_MISMATCH', unknownColumnPositions: [23], orderMismatch: true },
      })
    })

    it('checks the header before emptiness: a header-only file is EMPTY with the verified header', () => {
      expect(parseError(toBytes(`${HEADER_LINE}\n`))).toEqual({
        code: 'IMPORT_INVALID_CSV',
        details: { reason: 'EMPTY', delimiter: ',', header: [...LIBRARY_IMPORT_CSV_HEADER] },
      })
      expect(parseError(toBytes(`${HEADER_LINE}\n\n\r\n`))).toMatchObject({
        details: { reason: 'EMPTY' },
      })
      expect(parseError(toBytes(''))).toMatchObject({ details: { reason: 'HEADER_MISMATCH' } })
    })
  })

  describe('field validation', () => {
    it('produces structured row errors and keeps valid rows valid', () => {
      const result = parseOk(
        csvFile([
          dataRow({ isbn13: '9780306406158', orig_lang: 'zz', quantity: '0' }),
          dataRow({ isbn13: '978-0-306-40615-7', page_count: '1.0', is_abridged: 'TRUE' }),
          dataRow({ title: 'Valid' }),
        ]),
      )

      expect(result.rows.map((row) => row.payload.errors)).toEqual([
        [
          { code: 'INVALID_ISBN', field: 'isbn13' },
          { code: 'INVALID_FIELD', field: 'orig_lang' },
          { code: 'INVALID_FIELD', field: 'quantity' },
        ],
        [
          { code: 'INVALID_FIELD', field: 'is_abridged' },
          { code: 'INVALID_FIELD', field: 'page_count' },
        ],
        [],
      ])
      expect(result.rows[0]?.payload.values).toBeNull()
      expect(result.rows[2]?.payload.values).toMatchObject({ isbn13: VALID_ISBN, title: 'Valid' })
    })

    it('does not require catalog metadata beyond isbn13 (resolution is 8f-2)', () => {
      expect(errorsOf(parseOk(csvFile([dataRow()])).rows[0])).toEqual([])
    })

    it('keeps formula-like text as inert text', () => {
      const [row] = parseOk(csvFile([dataRow({ title: '=1+1', note: '@SUM(A1)' })])).rows

      expect(row?.payload.values).toMatchObject({ title: '=1+1', note: '@SUM(A1)' })
    })
  })

  describe('DUPLICATE_ROW', () => {
    it('flags rows differing only in quantity, pointing at the first valid occurrence', () => {
      const result = parseOk(
        csvFile([
          dataRow({ isbn13: '' }),
          dataRow({ quantity: '2' }),
          dataRow({ quantity: '3' }),
          dataRow({ quantity: '2' }),
        ]),
      )

      expect(result.rows.map((row) => row.payload.errors)).toEqual([
        [{ code: 'INVALID_ISBN', field: 'isbn13' }],
        [],
        [{ code: 'DUPLICATE_ROW', firstRowNumber: 2 }],
        [{ code: 'DUPLICATE_ROW', firstRowNumber: 2 }],
      ])
      // Flagged rows keep their own values: nothing is merged or summed.
      expect(result.rows.map((row) => row.payload.values?.quantity)).toEqual([undefined, 2, 3, 2])
    })

    it('compares normalized values: ISBN hyphens, trim, language case and explicit defaults', () => {
      const result = parseOk(
        csvFile([
          dataRow({ title: 'Кобзар', orig_lang: 'uk' }),
          dataRow({
            isbn13: '978-0-306-40615-7',
            title: '  Кобзар ',
            orig_lang: ' UK',
            format: 'PAPERBACK',
            condition: 'GOOD',
            visibility: 'FRIENDS',
          }),
        ]),
      )

      expect(errorsOf(result.rows[1])).toEqual([{ code: 'DUPLICATE_ROW', firstRowNumber: 1 }])
    })

    it('does not flag rows differing in a Copy attribute, ISBN or author order', () => {
      const result = parseOk(
        csvFile([
          dataRow({ authors: 'A|B' }),
          dataRow({ authors: 'B|A' }),
          dataRow({ authors: 'A|B', condition: 'WORN' }),
          dataRow({ authors: 'A|B', note: 'другий примірник' }),
          dataRow({ authors: 'A|B', isbn13: OTHER_VALID_ISBN }),
        ]),
      )

      expect(result.rows.flatMap((row) => row.payload.errors)).toEqual([])
    })

    it('does not treat text differing only in Unicode normalization as a duplicate', () => {
      const result = parseOk(csvFile([dataRow({ title: 'Café' }), dataRow({ title: 'Café' })]))

      expect(result.rows.flatMap((row) => row.payload.errors)).toEqual([])
    })
  })

  describe('limits', () => {
    const smallFile = csvText([dataRow()])

    function padTo(totalBytes: number, bom: boolean): Uint8Array {
      const padding = totalBytes - toBytes(smallFile, bom).length

      return toBytes(smallFile + '\n'.repeat(padding), bom)
    }

    it('accepts exactly 48 KiB and rejects one byte more, before parsing', () => {
      expect(parseOk(padTo(LIBRARY_IMPORT_LIMITS.maxBytes, false)).rows).toHaveLength(1)
      expect(parseError(padTo(LIBRARY_IMPORT_LIMITS.maxBytes + 1, false))).toEqual({
        code: 'IMPORT_TOO_LARGE',
        details: { limit: 'BYTES', max: 49152, actual: 49153 },
      })
    })

    it('counts the BOM in the size of the received file', () => {
      expect(parseOk(padTo(LIBRARY_IMPORT_LIMITS.maxBytes, true)).rows).toHaveLength(1)
      expect(parseError(padTo(LIBRARY_IMPORT_LIMITS.maxBytes + 1, true))).toMatchObject({
        details: { limit: 'BYTES', actual: 49153 },
      })
    })

    it('rejects oversized garbage by size, before decoding it', () => {
      const garbage = new Uint8Array(LIBRARY_IMPORT_LIMITS.maxBytes + 1).fill(0xff)

      expect(parseError(garbage)).toMatchObject({
        code: 'IMPORT_TOO_LARGE',
        details: { limit: 'BYTES' },
      })
    })

    it('accepts exactly 200 data rows and rejects 201', () => {
      const rows = (count: number): string[][] => Array.from({ length: count }, () => dataRow())

      expect(parseOk(csvFile(rows(200))).rows).toHaveLength(200)
      expect(parseError(csvFile(rows(201)))).toEqual({
        code: 'IMPORT_TOO_LARGE',
        details: { limit: 'ROWS', max: 200, actual: 201 },
      })
    })

    it('sums valid quantities of all rows (duplicates and invalid rows included) up to 500', () => {
      const atCap = [
        // 23 × 20 = 460, all duplicates of the first row but still counted.
        ...Array.from({ length: 23 }, () => dataRow({ quantity: '20' })),
        // A row with another field error still counts its valid quantity: 480.
        dataRow({ isbn13: 'not-an-isbn', quantity: '20' }),
        // Empty quantity counts as 1, `19` as 19: 500.
        dataRow({ condition: 'NEW' }),
        dataRow({ condition: 'WORN', quantity: '19' }),
        // Invalid quantities are not replaced by 1 and add nothing: still 500.
        dataRow({ condition: 'DAMAGED', quantity: '21' }),
        dataRow({ condition: 'DAMAGED', quantity: 'many' }),
      ]
      const result = parseOk(csvFile(atCap))

      expect(result.copyCount).toBe(500)
      expect(result.rows.at(-1)?.payload.errors).toEqual([
        { code: 'INVALID_FIELD', field: 'quantity' },
      ])

      expect(parseError(csvFile([...atCap, dataRow({ condition: 'DAMAGED' })]))).toEqual({
        code: 'IMPORT_TOO_LARGE',
        details: { limit: 'COPIES', max: 500, actual: 501 },
      })
    })

    it('parses a ~48 KiB record of multibyte text and escaped quotes without a structural error', () => {
      const chunk = 'ї"😀 '
      const header = toBytes(`${HEADER_LINE}\n`).length
      // Each chunk is 2 + 2 (escaped quote) + 4 + 1 = 9 bytes inside the quoted field.
      const repeats = Math.floor((LIBRARY_IMPORT_LIMITS.maxBytes - header - 200) / 9)
      const note = chunk.repeat(repeats)
      const bytes = csvFile([dataRow({ note })])

      expect(bytes.length).toBeGreaterThan(LIBRARY_IMPORT_LIMITS.maxBytes - 250)
      expect(bytes.length).toBeLessThanOrEqual(LIBRARY_IMPORT_LIMITS.maxBytes)

      const [row] = parseOk(bytes).rows

      expect(row?.payload.cells.note).toBe(note)
      expect(row?.payload.errors).toEqual([{ code: 'INVALID_FIELD', field: 'note' }])
    })
  })

  describe('sourceHash', () => {
    it('is SHA-256 of the bytes after removing one leading BOM', () => {
      const text = csvText([dataRow()])
      const expected = createHash('sha256').update(text, 'utf8').digest('hex')

      expect(parseOk(toBytes(text)).sourceHash).toBe(expected)
      expect(parseOk(toBytes(text, true)).sourceHash).toBe(expected)
    })

    it('does not normalize line endings: CRLF and LF files hash differently', () => {
      const lf = parseOk(csvFile([dataRow()], { eol: '\n' }))
      const crlf = parseOk(csvFile([dataRow()], { eol: '\r\n' }))

      expect(crlf.rows).toEqual(lf.rows)
      expect(crlf.sourceHash).not.toBe(lf.sourceHash)
    })
  })

  describe('privacy', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('never logs and never echoes file content in file-level errors', () => {
      const spies = [
        ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
          jest.spyOn(console, method).mockImplementation(() => undefined),
        ),
        ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((method) =>
          jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
        ),
      ]
      const secret = 'PRIVATE-NOTE-7f3a'
      const inputs = [
        csvFile([dataRow({ note: secret, quantity: '20' })]),
        toBytes(`${HEADER_LINE}\n"${secret},\n`),
        toBytes(`${HEADER_LINE}\n${secret},x\n`),
        toBytes(`${secret},${HEADER_LINE}\n`),
        toBytes(`${HEADER_LINE.replace('note', secret)}\n${csvLine(dataRow())}\n`),
      ]

      for (const input of inputs) {
        const result = parseLibraryImportCsv(input)

        if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(secret)
      }

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })
})
