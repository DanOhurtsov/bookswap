import { z } from 'zod'
import { editionFormatSchema } from '../domain/catalog'
import { conditionSchema } from '../domain/copy'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'
import { visibilitySchema } from '../domain/visibility'
import {
  CATALOG_LIMITS,
  createEditionRequestSchema,
  createTranslationRequestSchema,
  createWorkRequestSchema,
  workAuthorInputObjectSchema,
} from './catalog'
import { addCopyRequestSchema } from './library'

/**
 * Stage 8f-1 (docs/plan/stage-8-inventory.md, R4–R6, §4): the CSV v1 import
 * contract and the shape of persisted import draft rows.
 *
 * Every field rule is borrowed from an existing shared schema — the CSV adds
 * only the cell-level syntax (empty cell, strict integers, `true`/`false`,
 * `|`-separated authors). A second copy of a limit here would drift from the
 * manual add-book flow the first time either side changes.
 */

// --- CSV v1 format ----------------------------------------------------------

/** R4: the exact, ordered header. Unknown, duplicate, missing or reordered columns are rejected. */
export const LIBRARY_IMPORT_CSV_HEADER = [
  'isbn13',
  'title',
  'authors',
  'orig_lang',
  'first_pub_year',
  'edition_lang',
  'translator',
  'translation_source_lang',
  'translation_year',
  'is_abridged',
  'has_notes',
  'translation_notes',
  'publisher',
  'edition_year',
  'page_count',
  'cover_url',
  'format',
  'condition',
  'visibility',
  'note',
  'acquired_at',
  'quantity',
] as const

export const libraryImportCsvColumnSchema = z.enum(LIBRARY_IMPORT_CSV_HEADER)

export type LibraryImportCsvColumn = z.infer<typeof libraryImportCsvColumnSchema>

export const LIBRARY_IMPORT_LIMITS = {
  /** 48 KiB, measured on the file as received (a leading BOM included). */
  maxBytes: 48 * 1024,
  maxDataRows: 200,
  quantityMin: 1,
  quantityMax: 20,
  quantityDefault: 1,
  /** Upper bound on the sum of `quantity` over one file. */
  maxCopies: 500,
  draftTtlHours: 24,
} as const

/** R4: authors are `|`-separated; a literal `|` inside a name is not supported in v1. */
export const LIBRARY_IMPORT_AUTHOR_SEPARATOR = '|'

export const LIBRARY_IMPORT_DELIMITER = [',', ';'] as const

export const libraryImportDelimiterSchema = z.enum(LIBRARY_IMPORT_DELIMITER)

export type LibraryImportDelimiter = z.infer<typeof libraryImportDelimiterSchema>

/** R4 defaults for an empty `format`, `condition` and `visibility` cell. */
export const LIBRARY_IMPORT_DEFAULTS = {
  format: 'PAPERBACK',
  condition: 'GOOD',
  visibility: 'FRIENDS',
} as const

// --- Statuses and codes -----------------------------------------------------

/**
 * `EXPIRED`: a draft past its TTL — its rows are deleted, the metadata stays.
 * `COMMITTED` never expires and is never reset. Mirrors the Prisma enum
 * `LibraryImportStatus` (`apps/api/src/common/enum-parity.spec.ts`).
 */
export const LIBRARY_IMPORT_STATUS = ['DRAFT', 'EXPIRED', 'COMMITTED'] as const

export const libraryImportStatusSchema = z.enum(LIBRARY_IMPORT_STATUS)

export type LibraryImportStatus = z.infer<typeof libraryImportStatusSchema>

/** R5: one status per row. Mirrors the Prisma enum `LibraryImportRowStatus`. */
export const LIBRARY_IMPORT_ROW_STATUS = [
  'READY_EXISTING_EDITION',
  'READY_CREATE_CHAIN',
  'NEEDS_REVIEW',
  'INVALID',
  'SKIPPED',
] as const

export const libraryImportRowStatusSchema = z.enum(LIBRARY_IMPORT_ROW_STATUS)

export type LibraryImportRowStatus = z.infer<typeof libraryImportRowStatusSchema>

const READY_ROW_STATUSES: ReadonlySet<LibraryImportRowStatus> = new Set([
  'READY_EXISTING_EDITION',
  'READY_CREATE_CHAIN',
])

/**
 * §4: stable row error codes. Parsing (8f-1) produces only `INVALID_ISBN`,
 * `INVALID_FIELD` and `DUPLICATE_ROW`; the rest belong to catalog resolution
 * (8f-2), which also adds their detail shapes to `libraryImportRowErrorSchema`.
 */
export const LIBRARY_IMPORT_ROW_ERROR_CODE = [
  'INVALID_ISBN',
  'INVALID_FIELD',
  'DUPLICATE_ROW',
  'LOOKUP_UNAVAILABLE',
  'LOOKUP_NOT_FOUND',
  'MISSING_CATALOG_DATA',
  'AMBIGUOUS_CATALOG_MATCH',
] as const

export const libraryImportRowErrorCodeSchema = z.enum(LIBRARY_IMPORT_ROW_ERROR_CODE)

export type LibraryImportRowErrorCode = z.infer<typeof libraryImportRowErrorCodeSchema>

// --- Field rules (reused, never redefined) ----------------------------------

const titleSchema = createWorkRequestSchema.shape.title
const yearSchema = createWorkRequestSchema.shape.firstPubYear.unwrap().unwrap()
const authorNameSchema = workAuthorInputObjectSchema.shape.name.unwrap()
const authorsSchema = z.array(authorNameSchema).min(1).max(CATALOG_LIMITS.authorsMax)
const translatorSchema = createTranslationRequestSchema.shape.translator
const translationNotesSchema = createTranslationRequestSchema.shape.notes.unwrap().unwrap()
const publisherSchema = createEditionRequestSchema.shape.publisher.unwrap().unwrap()
const pageCountSchema = createEditionRequestSchema.shape.pageCount.unwrap().unwrap()
const coverUrlSchema = createEditionRequestSchema.shape.coverUrl.unwrap().unwrap()
const noteSchema = addCopyRequestSchema.shape.note.unwrap().unwrap()
const acquiredAtSchema = addCopyRequestSchema.shape.acquiredAt.unwrap().unwrap()
const quantitySchema = z
  .number()
  .int()
  .min(LIBRARY_IMPORT_LIMITS.quantityMin)
  .max(LIBRARY_IMPORT_LIMITS.quantityMax)

/** A normalized, validated data row — what a draft keeps and what 8g will commit. */
export const libraryImportRowValuesSchema = z.strictObject({
  isbn13: isbn13Schema,
  title: titleSchema.optional(),
  authors: authorsSchema.optional(),
  origLang: languageCodeSchema.optional(),
  firstPubYear: yearSchema.optional(),
  editionLang: languageCodeSchema.optional(),
  translator: translatorSchema.optional(),
  translationSourceLang: languageCodeSchema.optional(),
  translationYear: yearSchema.optional(),
  isAbridged: z.boolean().optional(),
  hasNotes: z.boolean().optional(),
  translationNotes: translationNotesSchema.optional(),
  publisher: publisherSchema.optional(),
  editionYear: yearSchema.optional(),
  pageCount: pageCountSchema.optional(),
  coverUrl: coverUrlSchema.optional(),
  format: editionFormatSchema,
  condition: conditionSchema,
  visibility: visibilitySchema,
  note: noteSchema.optional(),
  acquiredAt: acquiredAtSchema.optional(),
  quantity: quantitySchema,
})

export type LibraryImportRowValues = z.infer<typeof libraryImportRowValuesSchema>

/** Which value each CSV column feeds — one entry per column, in header order. */
export const LIBRARY_IMPORT_COLUMN_VALUE_KEYS = {
  isbn13: 'isbn13',
  title: 'title',
  authors: 'authors',
  orig_lang: 'origLang',
  first_pub_year: 'firstPubYear',
  edition_lang: 'editionLang',
  translator: 'translator',
  translation_source_lang: 'translationSourceLang',
  translation_year: 'translationYear',
  is_abridged: 'isAbridged',
  has_notes: 'hasNotes',
  translation_notes: 'translationNotes',
  publisher: 'publisher',
  edition_year: 'editionYear',
  page_count: 'pageCount',
  cover_url: 'coverUrl',
  format: 'format',
  condition: 'condition',
  visibility: 'visibility',
  note: 'note',
  acquired_at: 'acquiredAt',
  quantity: 'quantity',
} as const satisfies Record<LibraryImportCsvColumn, keyof LibraryImportRowValues>

// --- Cell syntax --------------------------------------------------------------

const EMPTY_CELL = ''

/** No sign other than `-`, no `-0`, no leading zeros, no fraction or exponent, no whitespace. */
const INTEGER_CELL_PATTERN = /^(0|-?[1-9]\d*)$/

function integerCell(schema: z.ZodType<number, number>): z.ZodType<number, string> {
  return z.string().regex(INTEGER_CELL_PATTERN).transform(Number).pipe(schema)
}

const booleanCellSchema = z.enum(['true', 'false']).transform((cell) => cell === 'true')

/**
 * An exactly empty cell means "not given" and yields `whenEmpty`; anything else
 * — whitespace included — goes through `schema` unchanged, so normalization is
 * exactly what the shared field rule does and nothing more.
 */
function cell<T, E>(schema: z.ZodType<T>, whenEmpty: E): z.ZodType<T | E, string> {
  return z.string().transform((raw, context): T | E => {
    if (raw === EMPTY_CELL) return whenEmpty

    const parsed = schema.safeParse(raw)

    if (parsed.success) return parsed.data

    context.addIssue({ code: 'custom', message: 'Invalid cell value' })

    return z.NEVER
  })
}

const authorsCellSchema = z
  .string()
  .transform((raw) => raw.split(LIBRARY_IMPORT_AUTHOR_SEPARATOR))
  .pipe(authorsSchema)

/** Exported separately: the parser sums valid quantities even on rows with other errors. */
export const libraryImportQuantityCellSchema = cell(
  integerCell(quantitySchema),
  LIBRARY_IMPORT_LIMITS.quantityDefault,
)

/**
 * One CSV data record keyed by column → typed values. Issue paths are column
 * names, so a caller maps failures to `INVALID_ISBN`/`INVALID_FIELD` per column.
 */
export const libraryImportCsvRowSchema = z
  .strictObject({
    isbn13: z.string().pipe(isbn13Schema),
    title: cell(titleSchema, undefined),
    authors: cell(authorsCellSchema, undefined),
    orig_lang: cell(languageCodeSchema, undefined),
    first_pub_year: cell(integerCell(yearSchema), undefined),
    edition_lang: cell(languageCodeSchema, undefined),
    translator: cell(translatorSchema, undefined),
    translation_source_lang: cell(languageCodeSchema, undefined),
    translation_year: cell(integerCell(yearSchema), undefined),
    is_abridged: cell(booleanCellSchema, undefined),
    has_notes: cell(booleanCellSchema, undefined),
    translation_notes: cell(translationNotesSchema, undefined),
    publisher: cell(publisherSchema, undefined),
    edition_year: cell(integerCell(yearSchema), undefined),
    page_count: cell(integerCell(pageCountSchema), undefined),
    cover_url: cell(coverUrlSchema, undefined),
    format: cell(editionFormatSchema, LIBRARY_IMPORT_DEFAULTS.format),
    condition: cell(conditionSchema, LIBRARY_IMPORT_DEFAULTS.condition),
    visibility: cell(visibilitySchema, LIBRARY_IMPORT_DEFAULTS.visibility),
    note: cell(noteSchema, undefined),
    acquired_at: cell(acquiredAtSchema, undefined),
    quantity: libraryImportQuantityCellSchema,
  })
  .transform((row): LibraryImportRowValues => ({
    isbn13: row.isbn13,
    title: row.title,
    authors: row.authors,
    origLang: row.orig_lang,
    firstPubYear: row.first_pub_year,
    editionLang: row.edition_lang,
    translator: row.translator,
    translationSourceLang: row.translation_source_lang,
    translationYear: row.translation_year,
    isAbridged: row.is_abridged,
    hasNotes: row.has_notes,
    translationNotes: row.translation_notes,
    publisher: row.publisher,
    editionYear: row.edition_year,
    pageCount: row.page_count,
    coverUrl: row.cover_url,
    format: row.format,
    condition: row.condition,
    visibility: row.visibility,
    note: row.note,
    acquiredAt: row.acquired_at,
    quantity: row.quantity,
  }))

/** The raw cells of one record, exactly as parsed — every column present, nothing extra. */
export const libraryImportCsvCellsSchema = z.record(
  libraryImportCsvColumnSchema,
  z.string().max(LIBRARY_IMPORT_LIMITS.maxBytes),
)

export type LibraryImportCsvCells = z.infer<typeof libraryImportCsvCellsSchema>

// --- Row errors and persisted rows -------------------------------------------

export const libraryImportRowNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(LIBRARY_IMPORT_LIMITS.maxDataRows)

export const libraryImportRowErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('INVALID_ISBN'), field: z.literal('isbn13') }),
  z.strictObject({
    code: z.literal('INVALID_FIELD'),
    field: libraryImportCsvColumnSchema.exclude(['isbn13']),
  }),
  /** R4: a repeated normalized row is flagged, never merged into the first one. */
  z.strictObject({
    code: z.literal('DUPLICATE_ROW'),
    firstRowNumber: libraryImportRowNumberSchema,
  }),
])

export type LibraryImportRowError = z.infer<typeof libraryImportRowErrorSchema>

/**
 * What one draft row stores. `values` is `null` exactly when a field failed to
 * parse; the raw file itself is never stored, only these per-row cells, which
 * are deleted with the row on expiry or commit.
 */
export const libraryImportRowPayloadSchema = z
  .strictObject({
    cells: libraryImportCsvCellsSchema,
    values: libraryImportRowValuesSchema.nullable(),
    errors: z.array(libraryImportRowErrorSchema).max(LIBRARY_IMPORT_CSV_HEADER.length),
  })
  .refine((payload) => payload.values !== null || payload.errors.length > 0, {
    message: 'A row without values must carry at least one error',
    path: ['errors'],
  })

export type LibraryImportRowPayload = z.infer<typeof libraryImportRowPayloadSchema>

export const libraryImportRowRecordSchema = z
  .strictObject({
    rowNumber: libraryImportRowNumberSchema,
    status: libraryImportRowStatusSchema,
    payload: libraryImportRowPayloadSchema,
  })
  .superRefine((row, context) => {
    const { errors, values } = row.payload

    if (row.status === 'INVALID' && errors.length === 0) {
      context.addIssue({ code: 'custom', message: 'INVALID row without errors', path: ['status'] })
    }

    if (READY_ROW_STATUSES.has(row.status) && (errors.length > 0 || values === null)) {
      context.addIssue({ code: 'custom', message: 'READY row must be valid', path: ['status'] })
    }

    if (values === null && row.status !== 'INVALID' && row.status !== 'SKIPPED') {
      context.addIssue({ code: 'custom', message: 'Row without values', path: ['status'] })
    }

    for (const error of errors) {
      if (error.code === 'DUPLICATE_ROW' && error.firstRowNumber >= row.rowNumber) {
        context.addIssue({
          code: 'custom',
          message: 'DUPLICATE_ROW must point to an earlier row',
          path: ['payload', 'errors'],
        })
      }
    }
  })

export type LibraryImportRowRecord = z.infer<typeof libraryImportRowRecordSchema>

// --- File-level errors ---------------------------------------------------------

export const LIBRARY_IMPORT_SIZE_LIMIT = ['BYTES', 'ROWS', 'COPIES'] as const

/** `details` of `IMPORT_TOO_LARGE`. */
export const libraryImportTooLargeDetailsSchema = z.strictObject({
  limit: z.enum(LIBRARY_IMPORT_SIZE_LIMIT),
  max: z.number().int().positive(),
  actual: z.number().int().positive(),
})

export type LibraryImportTooLargeDetails = z.infer<typeof libraryImportTooLargeDetailsSchema>

export const LIBRARY_IMPORT_INVALID_CSV_REASON = [
  'HEADER_MISMATCH',
  'AMBIGUOUS_DELIMITER',
  'COLUMN_COUNT',
  'MALFORMED_CSV',
  'INVALID_ENCODING',
  'EMPTY',
] as const

const physicalLineSchema = z.number().int().positive()

/**
 * `details` of `IMPORT_INVALID_CSV`. Never echoes file content: unknown header
 * names are reported by 1-based position only.
 */
export const libraryImportInvalidCsvDetailsSchema = z.discriminatedUnion('reason', [
  z.strictObject({
    reason: z.literal('HEADER_MISMATCH'),
    missingColumns: z.array(libraryImportCsvColumnSchema),
    duplicateColumns: z.array(libraryImportCsvColumnSchema),
    unknownColumnPositions: z.array(z.number().int().positive()),
    orderMismatch: z.boolean(),
  }),
  z.strictObject({ reason: z.literal('AMBIGUOUS_DELIMITER') }),
  z.strictObject({ reason: z.literal('COLUMN_COUNT'), line: physicalLineSchema }),
  z.strictObject({ reason: z.literal('MALFORMED_CSV'), line: physicalLineSchema }),
  z.strictObject({ reason: z.literal('INVALID_ENCODING') }),
  /** Header already verified: a header-only file (such as the template) lands here. */
  z.strictObject({
    reason: z.literal('EMPTY'),
    delimiter: libraryImportDelimiterSchema,
    header: z.array(libraryImportCsvColumnSchema),
  }),
])

export type LibraryImportInvalidCsvDetails = z.infer<typeof libraryImportInvalidCsvDetailsSchema>
