import { CATALOG_LIMITS } from './catalog'
import {
  LIBRARY_IMPORT_COLUMN_VALUE_KEYS,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  libraryImportCsvCellsSchema,
  libraryImportCsvRowSchema,
  libraryImportInvalidCsvDetailsSchema,
  libraryImportQuantityCellSchema,
  libraryImportRowRecordSchema,
  libraryImportRowValuesSchema,
  type LibraryImportCsvCells,
  type LibraryImportCsvColumn,
} from './library-import'

const VALID_ISBN = '9780306406157'

function cells(overrides: Partial<LibraryImportCsvCells> = {}): LibraryImportCsvCells {
  const empty = Object.fromEntries(LIBRARY_IMPORT_CSV_HEADER.map((column) => [column, '']))

  return libraryImportCsvCellsSchema.parse({ ...empty, isbn13: VALID_ISBN, ...overrides })
}

function failedColumns(overrides: Partial<LibraryImportCsvCells>): LibraryImportCsvColumn[] {
  const result = libraryImportCsvRowSchema.safeParse(cells(overrides))

  if (result.success) return []

  const failed = new Set(result.error.issues.map((issue) => issue.path[0]))

  return LIBRARY_IMPORT_CSV_HEADER.filter((column) => failed.has(column))
}

function accepts(column: LibraryImportCsvColumn, value: string): boolean {
  return failedColumns({ [column]: value }).length === 0
}

describe('LIBRARY_IMPORT_CSV_HEADER', () => {
  it('is exactly the R4 header, in order', () => {
    expect(LIBRARY_IMPORT_CSV_HEADER.join(',')).toBe(
      'isbn13,title,authors,orig_lang,first_pub_year,edition_lang,translator,translation_source_lang,translation_year,is_abridged,has_notes,translation_notes,publisher,edition_year,page_count,cover_url,format,condition,visibility,note,acquired_at,quantity',
    )
  })

  it('maps every column to a value key, in header order', () => {
    expect(Object.keys(LIBRARY_IMPORT_COLUMN_VALUE_KEYS)).toEqual([...LIBRARY_IMPORT_CSV_HEADER])
    expect(Object.values(LIBRARY_IMPORT_COLUMN_VALUE_KEYS).sort()).toEqual(
      Object.keys(libraryImportRowValuesSchema.shape).sort(),
    )
  })
})

describe('libraryImportCsvCellsSchema', () => {
  it('rejects a missing or an extra column', () => {
    const { note: _note, ...missing } = cells()

    expect(libraryImportCsvCellsSchema.safeParse(missing).success).toBe(false)
    expect(libraryImportCsvCellsSchema.safeParse({ ...cells(), extra: '' }).success).toBe(false)
  })
})

describe('libraryImportCsvRowSchema', () => {
  it('needs only isbn13 and applies the R4 defaults', () => {
    expect(libraryImportCsvRowSchema.parse(cells())).toEqual({
      isbn13: VALID_ISBN,
      format: 'PAPERBACK',
      condition: 'GOOD',
      visibility: 'FRIENDS',
      quantity: 1,
    })
  })

  it('normalizes only as the shared field rules do', () => {
    const values = libraryImportCsvRowSchema.parse(
      cells({
        isbn13: ' 978-0-306-40615-7 ',
        title: '  Тіні забутих предків  ',
        orig_lang: ' UK ',
        authors: 'Михайло Коцюбинський | Emoji 📚',
      }),
    )

    expect(values.isbn13).toBe(VALID_ISBN)
    expect(values.title).toBe('Тіні забутих предків')
    expect(values.origLang).toBe('uk')
    expect(values.authors).toEqual(['Михайло Коцюбинський', 'Emoji 📚'])
  })

  it('keeps Unicode text byte-for-byte (no NFC normalization)', () => {
    const decomposed = 'Café'

    expect(libraryImportCsvRowSchema.parse(cells({ title: decomposed })).title).toBe(decomposed)
  })

  it('reports isbn13 problems on the isbn13 column, including an empty cell', () => {
    expect(failedColumns({ isbn13: '' })).toEqual(['isbn13'])
    expect(failedColumns({ isbn13: '9780306406158' })).toEqual(['isbn13'])
    expect(failedColumns({ isbn13: '4006381333931' })).toEqual(['isbn13'])
  })

  it('collects every failing column, not only the first', () => {
    expect(failedColumns({ orig_lang: 'zz', quantity: '0', format: 'paperback' })).toEqual([
      'orig_lang',
      'format',
      'quantity',
    ])
  })

  describe('integers: strict syntax, no implicit casts', () => {
    it.each(['01', '1.0', '1e1', '+1', ' 1', '1 ', '0x10', 'one', '-0'])('rejects %j', (value) => {
      expect(accepts('page_count', value)).toBe(false)
    })

    it('accepts zero and negative years, but not -0', () => {
      expect(accepts('first_pub_year', '0')).toBe(true)
      expect(accepts('first_pub_year', '-350')).toBe(true)
      expect(accepts('first_pub_year', '-0')).toBe(false)
    })

    it('year bounds are the catalog limits', () => {
      for (const column of ['first_pub_year', 'translation_year', 'edition_year'] as const) {
        expect(accepts(column, String(CATALOG_LIMITS.yearMin))).toBe(true)
        expect(accepts(column, String(CATALOG_LIMITS.yearMin - 1))).toBe(false)
        expect(accepts(column, String(CATALOG_LIMITS.yearMax))).toBe(true)
        expect(accepts(column, String(CATALOG_LIMITS.yearMax + 1))).toBe(false)
      }
    })

    it('page_count bounds are the catalog limits', () => {
      expect(accepts('page_count', '0')).toBe(false)
      expect(accepts('page_count', '1')).toBe(true)
      expect(accepts('page_count', String(CATALOG_LIMITS.pageCountMax))).toBe(true)
      expect(accepts('page_count', String(CATALOG_LIMITS.pageCountMax + 1))).toBe(false)
    })
  })

  describe('quantity', () => {
    it('defaults an empty cell to 1 and accepts exactly 1..20', () => {
      expect(libraryImportQuantityCellSchema.parse('')).toBe(1)
      expect(libraryImportQuantityCellSchema.parse('1')).toBe(1)
      expect(libraryImportQuantityCellSchema.parse('20')).toBe(LIBRARY_IMPORT_LIMITS.quantityMax)
    })

    it.each(['0', '21', '-1', '01', '1.0', ' 1'])(
      'rejects %j instead of falling back to 1',
      (value) => {
        expect(libraryImportQuantityCellSchema.safeParse(value).success).toBe(false)
      },
    )
  })

  it('booleans are only lowercase true/false', () => {
    expect(
      libraryImportCsvRowSchema.parse(cells({ is_abridged: 'true', has_notes: 'false' })),
    ).toMatchObject({
      isAbridged: true,
      hasNotes: false,
    })

    for (const value of ['TRUE', 'True', '1', 'yes', ' true']) {
      expect(accepts('is_abridged', value)).toBe(false)
    }
  })

  it('enums are case-sensitive existing values', () => {
    expect(accepts('format', 'HARDCOVER')).toBe(true)
    expect(accepts('format', 'hardcover')).toBe(false)
    expect(accepts('condition', 'WORN')).toBe(true)
    expect(accepts('condition', 'MINT')).toBe(false)
    expect(accepts('visibility', 'PRIVATE')).toBe(true)
    expect(accepts('visibility', 'SECRET')).toBe(false)
  })

  it('authors: order kept, 1..authorsMax names, each within authorNameMax, no empty segment', () => {
    const names = Array.from(
      { length: CATALOG_LIMITS.authorsMax },
      (_, index) => `A${String(index)}`,
    )

    expect(libraryImportCsvRowSchema.parse(cells({ authors: names.join('|') })).authors).toEqual(
      names,
    )
    expect(accepts('authors', [...names, 'Extra'].join('|'))).toBe(false)
    expect(accepts('authors', 'a'.repeat(CATALOG_LIMITS.authorNameMax))).toBe(true)
    expect(accepts('authors', 'a'.repeat(CATALOG_LIMITS.authorNameMax + 1))).toBe(false)
    expect(accepts('authors', 'A||B')).toBe(false)
    expect(accepts('authors', 'A|')).toBe(false)
    expect(accepts('authors', ' ')).toBe(false)
  })

  it('text limits come from the catalog and library contracts', () => {
    expect(accepts('title', 'a'.repeat(CATALOG_LIMITS.titleMax))).toBe(true)
    expect(accepts('title', 'a'.repeat(CATALOG_LIMITS.titleMax + 1))).toBe(false)
    expect(accepts('title', '   ')).toBe(false)
    expect(accepts('note', 'a'.repeat(1000))).toBe(true)
    expect(accepts('note', 'a'.repeat(1001))).toBe(false)
    expect(accepts('cover_url', 'not a url')).toBe(false)
    expect(accepts('cover_url', 'https://covers.example.com/1.jpg')).toBe(true)
  })

  it('languages must be ISO 639-1 codes', () => {
    expect(accepts('edition_lang', 'en')).toBe(true)
    expect(accepts('edition_lang', 'eng')).toBe(false)
    expect(accepts('translation_source_lang', 'zz')).toBe(false)
  })

  it('acquired_at is a real YYYY-MM-DD date', () => {
    expect(accepts('acquired_at', '2024-02-29')).toBe(true)
    expect(accepts('acquired_at', '2026-02-30')).toBe(false)
    expect(accepts('acquired_at', '2026-1-01')).toBe(false)
    expect(accepts('acquired_at', '2026-01-01T00:00:00Z')).toBe(false)
  })

  it('formula-like text stays inert text', () => {
    expect(libraryImportCsvRowSchema.parse(cells({ note: '=HYPERLINK("x")' })).note).toBe(
      '=HYPERLINK("x")',
    )
  })
})

describe('libraryImportRowRecordSchema', () => {
  const validPayload = {
    cells: cells(),
    values: libraryImportCsvRowSchema.parse(cells()),
    errors: [],
  }

  it('accepts a valid READY row and an INVALID row with errors', () => {
    expect(
      libraryImportRowRecordSchema.safeParse({
        rowNumber: 1,
        status: 'READY_EXISTING_EDITION',
        payload: validPayload,
      }).success,
    ).toBe(true)
    expect(
      libraryImportRowRecordSchema.safeParse({
        rowNumber: 2,
        status: 'INVALID',
        payload: {
          cells: cells({ isbn13: '' }),
          values: null,
          errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
        },
      }).success,
    ).toBe(true)
  })

  it('rejects inconsistent status/errors/values combinations', () => {
    const invalidWithoutErrors = { rowNumber: 1, status: 'INVALID', payload: validPayload }
    const readyWithErrors = {
      rowNumber: 2,
      status: 'READY_CREATE_CHAIN',
      payload: { ...validPayload, errors: [{ code: 'DUPLICATE_ROW', firstRowNumber: 1 }] },
    }
    const needsReviewWithoutValues = {
      rowNumber: 1,
      status: 'NEEDS_REVIEW',
      payload: {
        ...validPayload,
        values: null,
        errors: [{ code: 'INVALID_FIELD', field: 'title' }],
      },
    }
    const duplicateOfLaterRow = {
      rowNumber: 2,
      status: 'INVALID',
      payload: { ...validPayload, errors: [{ code: 'DUPLICATE_ROW', firstRowNumber: 2 }] },
    }

    for (const record of [
      invalidWithoutErrors,
      readyWithErrors,
      needsReviewWithoutValues,
      duplicateOfLaterRow,
    ]) {
      expect(libraryImportRowRecordSchema.safeParse(record).success).toBe(false)
    }
  })

  it('rejects unknown keys, unknown error codes and INVALID_FIELD on isbn13', () => {
    const base = { rowNumber: 1, status: 'INVALID' as const }

    expect(
      libraryImportRowRecordSchema.safeParse({ ...base, payload: { ...validPayload, extra: 1 } })
        .success,
    ).toBe(false)
    expect(
      libraryImportRowRecordSchema.safeParse({
        ...base,
        payload: { ...validPayload, errors: [{ code: 'TEAPOT' }] },
      }).success,
    ).toBe(false)
    expect(
      libraryImportRowRecordSchema.safeParse({
        ...base,
        payload: { ...validPayload, errors: [{ code: 'INVALID_FIELD', field: 'isbn13' }] },
      }).success,
    ).toBe(false)
  })

  it('bounds rowNumber to 1..maxDataRows', () => {
    for (const rowNumber of [0, LIBRARY_IMPORT_LIMITS.maxDataRows + 1, 1.5]) {
      expect(
        libraryImportRowRecordSchema.safeParse({
          rowNumber,
          status: 'SKIPPED',
          payload: validPayload,
        }).success,
      ).toBe(false)
    }
  })
})

describe('libraryImportInvalidCsvDetailsSchema', () => {
  it('does not accept free-form header text in HEADER_MISMATCH details', () => {
    expect(
      libraryImportInvalidCsvDetailsSchema.safeParse({
        reason: 'HEADER_MISMATCH',
        missingColumns: ['secret column'],
        duplicateColumns: [],
        unknownColumnPositions: [],
        orderMismatch: false,
      }).success,
    ).toBe(false)
  })
})
