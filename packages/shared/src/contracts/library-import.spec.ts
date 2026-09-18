import { CATALOG_LIMITS } from './catalog'
import {
  LIBRARY_IMPORT_COLUMN_VALUE_KEYS,
  LIBRARY_IMPORT_CONTENT_BASE64_MAX,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  libraryImportCsvCellsSchema,
  libraryImportCsvRowSchema,
  libraryImportInvalidCsvDetailsSchema,
  libraryImportPreviewRequestSchema,
  libraryImportQuantityCellSchema,
  libraryImportRowErrorSchema,
  libraryImportRowPatchRequestSchema,
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
  /** 8f-2: a READY row carries the resolution its status names. */
  const existingEdition = { kind: 'EXISTING_EDITION', editionId: 'ed-1', workId: 'w-1' } as const
  const resolvedCatalog = {
    work: { title: 'Дюна', authors: ['Френк Герберт'], origLang: 'en', firstPubYear: 1965 },
    translation: null,
    edition: {
      isbn13: VALID_ISBN,
      publisher: null,
      year: null,
      pageCount: null,
      coverUrl: null,
      format: 'PAPERBACK',
    },
  }
  const validPayload = {
    cells: cells(),
    values: libraryImportCsvRowSchema.parse(cells()),
    errors: [],
    resolution: existingEdition,
    rowVersion: 'row-version-1',
  }
  const unresolved = { ...validPayload, resolution: null }

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
          rowVersion: 'row-version-2',
        },
      }).success,
    ).toBe(true)
  })

  it('rejects inconsistent status/errors/values combinations', () => {
    // Each case below isolates ONE inconsistency, so `resolution` is set to
    // whatever the status expects and never doubles as a second reason to fail.
    const invalidWithoutErrors = { rowNumber: 1, status: 'INVALID', payload: unresolved }
    const readyWithErrors = {
      rowNumber: 2,
      status: 'READY_CREATE_CHAIN',
      payload: {
        ...validPayload,
        resolution: { kind: 'CREATE_CHAIN', workId: null, catalog: resolvedCatalog },
        errors: [{ code: 'DUPLICATE_ROW', firstRowNumber: 1 }],
      },
    }
    const needsReviewWithoutValues = {
      rowNumber: 1,
      status: 'NEEDS_REVIEW',
      payload: {
        ...unresolved,
        values: null,
        errors: [{ code: 'INVALID_FIELD', field: 'title' }],
      },
    }
    const duplicateOfLaterRow = {
      rowNumber: 2,
      status: 'INVALID',
      payload: { ...unresolved, errors: [{ code: 'DUPLICATE_ROW', firstRowNumber: 2 }] },
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

  /**
   * 8f-2: the status and the stored resolution are one fact, not two. A
   * `NEEDS_REVIEW` row holding the resolution it had before an edit is exactly
   * the drift R5 forbids — a changed ISBN must not keep the old edition.
   */
  it('ties each status to the resolution it is allowed to carry', () => {
    const createChain = { kind: 'CREATE_CHAIN', workId: null, catalog: resolvedCatalog }
    const at = (status: string, resolution: unknown): boolean =>
      libraryImportRowRecordSchema.safeParse({
        rowNumber: 1,
        status,
        payload: {
          ...unresolved,
          resolution,
          errors: status === 'NEEDS_REVIEW' ? [{ code: 'LOOKUP_NOT_FOUND' }] : [],
        },
      }).success

    expect(at('READY_EXISTING_EDITION', existingEdition)).toBe(true)
    expect(at('READY_CREATE_CHAIN', createChain)).toBe(true)
    expect(at('NEEDS_REVIEW', null)).toBe(true)
    expect(at('READY_EXISTING_EDITION', createChain)).toBe(false)
    expect(at('READY_CREATE_CHAIN', existingEdition)).toBe(false)
    expect(at('READY_CREATE_CHAIN', null)).toBe(false)
    expect(at('NEEDS_REVIEW', createChain)).toBe(false)
  })

  it('rejects unknown keys, unknown error codes and INVALID_FIELD on isbn13', () => {
    const base = { rowNumber: 1, status: 'INVALID' as const }

    expect(
      libraryImportRowRecordSchema.safeParse({ ...base, payload: { ...unresolved, extra: 1 } })
        .success,
    ).toBe(false)
    expect(
      libraryImportRowRecordSchema.safeParse({
        ...base,
        payload: { ...unresolved, errors: [{ code: 'TEAPOT' }] },
      }).success,
    ).toBe(false)
    expect(
      libraryImportRowRecordSchema.safeParse({
        ...base,
        payload: { ...unresolved, errors: [{ code: 'INVALID_FIELD', field: 'isbn13' }] },
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

/** Stage 8f-2: the HTTP contracts of the preview endpoints. */
describe('libraryImportPreviewRequestSchema', () => {
  const accepts = (contentBase64: string): boolean =>
    libraryImportPreviewRequestSchema.safeParse({ contentBase64 }).success

  it('accepts standard padded base64 only', () => {
    expect(accepts(Buffer.from('isbn13,title').toString('base64'))).toBe(true)
    expect(accepts('aXNibjEz')).toBe(true)
    expect(accepts('aXNibjEzLA==')).toBe(true)
  })

  /**
   * `Buffer.from(…, 'base64')` silently skips what it cannot read, so a request
   * mangled in transit would decode to a SHORTER file — and hash, parse and
   * import as a different one. Everything below has to be rejected before the
   * decode, not tidied up during it.
   */
  it('rejects anything Buffer.from would quietly repair', () => {
    expect(accepts('data:text/csv;base64,aXNibjEz')).toBe(false)
    expect(accepts('aXNi bjEz')).toBe(false)
    expect(accepts('aXNibjEz\naXNibjEz')).toBe(false)
    expect(accepts('aXNibjEz-_')).toBe(false)
    expect(accepts('aXNibjEz=')).toBe(false)
    expect(accepts('!!!!')).toBe(false)
    expect(accepts('')).toBe(false)
  })

  it('caps the payload at the transport limit and rejects unknown fields', () => {
    expect(accepts('A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX))).toBe(true)
    expect(accepts('A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX + 4))).toBe(false)
    expect(
      libraryImportPreviewRequestSchema.safeParse({ contentBase64: 'aXNibjEz', delimiter: ',' })
        .success,
    ).toBe(false)
  })

  /**
   * The transport cap is deliberately larger than the 48 KiB file cap: a file
   * a little over the limit must reach the parser and come back as
   * IMPORT_TOO_LARGE with its real size, not as a bare validation error.
   */
  it('leaves room above the file limit for an honest IMPORT_TOO_LARGE', () => {
    expect(LIBRARY_IMPORT_CONTENT_BASE64_MAX).toBeGreaterThan(
      Math.ceil(LIBRARY_IMPORT_LIMITS.maxBytes / 3) * 4,
    )
  })
})

describe('libraryImportRowPatchRequestSchema', () => {
  const accepts = (body: unknown): boolean =>
    libraryImportRowPatchRequestSchema.safeParse(body).success

  const at = 'row-version-1'

  it('accepts one shape per action', () => {
    expect(accepts({ action: 'EDIT', expectedRowVersion: at, cells: { title: 'Дюна' } })).toBe(true)
    expect(accepts({ action: 'CHOOSE', expectedRowVersion: at, workId: 'work-1' })).toBe(true)
    expect(accepts({ action: 'CHOOSE', expectedRowVersion: at, workId: null })).toBe(true)
    expect(accepts({ action: 'SKIP', expectedRowVersion: at })).toBe(true)
    expect(accepts({ action: 'RESTORE', expectedRowVersion: at })).toBe(true)
    expect(accepts({ action: 'RETRY', expectedRowVersion: at })).toBe(true)
  })

  /**
   * Agreed 8f-2 concurrency contract: the version is required for EVERY action,
   * including the ones that never call a provider. Which row the person meant is
   * the question, not how long the server took.
   */
  it('rejects any action without expectedRowVersion', () => {
    expect(accepts({ action: 'SKIP' })).toBe(false)
    expect(accepts({ action: 'RETRY' })).toBe(false)
    expect(accepts({ action: 'RESTORE' })).toBe(false)
    expect(accepts({ action: 'EDIT', cells: { title: 'Дюна' } })).toBe(false)
    expect(accepts({ action: 'CHOOSE', workId: null })).toBe(false)
    expect(accepts({ action: 'SKIP', expectedRowVersion: '' })).toBe(false)
  })

  it('rejects a field that belongs to another action', () => {
    expect(accepts({ action: 'SKIP', expectedRowVersion: at, workId: 'work-1' })).toBe(false)
    expect(accepts({ action: 'RETRY', expectedRowVersion: at, cells: { title: 'Д' } })).toBe(false)
    expect(
      accepts({ action: 'EDIT', expectedRowVersion: at, cells: { title: 'Д' }, workId: 'w-1' }),
    ).toBe(false)
  })

  it('rejects an empty or unknown edit', () => {
    expect(accepts({ action: 'EDIT', expectedRowVersion: at, cells: {} })).toBe(false)
    expect(accepts({ action: 'EDIT', expectedRowVersion: at, cells: { not_a_column: 'x' } })).toBe(
      false,
    )
    expect(accepts({ action: 'EDIT', expectedRowVersion: at, cells: { title: 42 } })).toBe(false)
    expect(accepts({ action: 'EDIT', expectedRowVersion: at })).toBe(false)
    expect(accepts({ action: 'CHOOSE', expectedRowVersion: at })).toBe(false)
    expect(accepts({ action: 'UNSKIP', expectedRowVersion: at })).toBe(false)
  })
})

describe('libraryImportRowErrorSchema', () => {
  it('marks every lookup failure retryable and keeps "not found" separate', () => {
    expect(
      libraryImportRowErrorSchema.safeParse({
        code: 'LOOKUP_UNAVAILABLE',
        reason: 'TIMEOUT',
        retryable: true,
      }).success,
    ).toBe(true)
    // A non-retryable LOOKUP_UNAVAILABLE must not be expressible: "we could not
    // ask" is always worth asking again.
    expect(
      libraryImportRowErrorSchema.safeParse({
        code: 'LOOKUP_UNAVAILABLE',
        reason: 'TIMEOUT',
        retryable: false,
      }).success,
    ).toBe(false)
    expect(libraryImportRowErrorSchema.safeParse({ code: 'LOOKUP_NOT_FOUND' }).success).toBe(true)
    expect(
      libraryImportRowErrorSchema.safeParse({ code: 'LOOKUP_UNAVAILABLE', retryable: true })
        .success,
    ).toBe(false)
  })

  it('AMBIGUOUS_CATALOG_MATCH always carries at least one candidate', () => {
    const candidate = { workId: 'w-1', title: 'Дюна', authors: ['Френк Герберт'] }

    expect(
      libraryImportRowErrorSchema.safeParse({
        code: 'AMBIGUOUS_CATALOG_MATCH',
        candidates: [candidate],
      }).success,
    ).toBe(true)
    expect(
      libraryImportRowErrorSchema.safeParse({ code: 'AMBIGUOUS_CATALOG_MATCH', candidates: [] })
        .success,
    ).toBe(false)
  })

  it('MISSING_CATALOG_DATA names real CSV columns', () => {
    expect(
      libraryImportRowErrorSchema.safeParse({ code: 'MISSING_CATALOG_DATA', fields: ['title'] })
        .success,
    ).toBe(true)
    expect(
      libraryImportRowErrorSchema.safeParse({ code: 'MISSING_CATALOG_DATA', fields: ['nope'] })
        .success,
    ).toBe(false)
    expect(
      libraryImportRowErrorSchema.safeParse({ code: 'MISSING_CATALOG_DATA', fields: [] }).success,
    ).toBe(false)
  })
})
