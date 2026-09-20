import { z } from 'zod'
import { editionFormatSchema } from '../domain/catalog'
import { conditionSchema } from '../domain/copy'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'
import { visibilitySchema } from '../domain/visibility'
import {
  CATALOG_LIMITS,
  SEARCH_CANDIDATES_LIMIT,
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

/**
 * 8f-4 (agreed PO decision, 2026-09-19): which file the bytes are.
 *
 * A discriminator rather than byte sniffing: sniffing would give two routes to
 * one state and would quietly disagree with the file's own extension. Omitted
 * means `CSV`, so every request written against the 8f-2 contract keeps working
 * untouched; `null`, `''` and anything not in this list are validation errors,
 * never a silent fallback.
 */
export const LIBRARY_IMPORT_FORMAT = ['CSV', 'XLSX'] as const

export const libraryImportFormatSchema = z.enum(LIBRARY_IMPORT_FORMAT)

export type LibraryImportFormat = z.infer<typeof libraryImportFormatSchema>

export const LIBRARY_IMPORT_LIMITS = {
  /** 48 KiB, measured on the file as received (a leading BOM included). */
  maxBytes: 48 * 1024,
  /**
   * 8f-2: how many decoded bytes the preview endpoint accepts at all. Larger
   * than every per-format cap on purpose — a file modestly over its cap must
   * come back as `IMPORT_TOO_LARGE` with its real size, not as a
   * transport-level rejection that says nothing about why.
   */
  maxRequestBytes: 768 * 1024,
  maxDataRows: 200,
  quantityMin: 1,
  quantityMax: 20,
  quantityDefault: 1,
  /** Upper bound on the sum of `quantity` over one file. */
  maxCopies: 500,
  draftTtlHours: 24,
} as const

/**
 * 8f-4 (agreed PO limits): what an `.xlsx` may cost us.
 *
 * The 48 KiB CSV cap deliberately does NOT carry over. A CSV's bytes are its
 * content, so one number bounds both the file and the work of reading it. An
 * `.xlsx` is a ZIP: its bytes bound nothing on their own, because the XML
 * inside routinely expands five to twenty times — and a hostile file expands
 * without limit. So the size of the container, the size of what it actually
 * decompresses to, and the shape of the workbook are three separate caps, each
 * enforced at the only moment it can be known.
 */
export const LIBRARY_IMPORT_XLSX_LIMITS = {
  /** The container as received, checked before anything is decompressed. */
  maxBytes: 512 * 1024,
  /**
   * The real total of decompressed bytes, counted as they are produced and
   * abandoned the moment it is passed — never the archive's own claim about
   * itself, which costs an attacker nothing to forge.
   */
  maxUncompressedBytes: 8 * 1024 * 1024,
  /** A single member may not be larger than the whole budget either. */
  maxEntryUncompressedBytes: 8 * 1024 * 1024,
  maxEntries: 64,
  /**
   * An extra filter on top of `maxUncompressedBytes`, not a substitute for it:
   * it rejects the classic bomb early, while the byte budget is what actually
   * guarantees termination.
   */
  maxCompressionRatio: 200,
  /** Workbook complexity: a small ZIP does not imply a small workbook. */
  maxSheets: 16,
  /** Populated cells on the data sheet — counted, never taken from `dimension`. */
  maxCells: 100_000,
  /**
   * How many `<row>` ELEMENTS one sheet's markup may contain, empty ones
   * included (agreed PO decision, 2026-09-19).
   *
   * Three things this is not. It is not a number of books: the product limit
   * stays `maxDataRows` (200), and it is enforced separately, on data rows. It
   * is not a maximum row index either — a sheet may address row 1 048 576, and
   * an index beyond Excel's own grid is refused by the reference check, not by
   * this. And it is not a cell count: `maxCells` bounds those.
   *
   * It exists because `maxCells` alone leaves a hole. A sheet of a million
   * EMPTY `<row/>` elements holds no cells at all and still makes the workbook
   * reader build a million row objects. Set a hundredfold above the 200 data
   * rows an import may carry, so that the trailing styled-but-empty rows Excel
   * writes freely never cost anyone their file.
   */
  maxSheetRows: 20_000,
} as const

/**
 * 8f-4 (agreed PO decision): the exact bytes hashed before an `.xlsx`'s own.
 *
 * `sourceHash` is `SHA-256(prefix ‖ file)` for XLSX and stays `SHA-256(file)`
 * — after one leading BOM — for CSV, untouched. Two consequences, both wanted:
 * every import saved by 8f-1/8f-2 keeps the hash it already has and is still
 * found by a repeated CSV upload, and a workbook can never collide with a CSV
 * that happens to describe the same books. They are different files, they show
 * the owner different cells, and they fail in different ways, so they are not
 * one import.
 *
 * The prefix is versioned: should the reader ever change what it makes of the
 * same bytes, `v2` would let old drafts expire on their own rather than be
 * answered with a draft built under rules that no longer apply.
 */
export const LIBRARY_IMPORT_XLSX_HASH_PREFIX = 'bookswap:library-import:xlsx:v1\n'

/** Per-format cap on the file as received. One lookup, so no call site retypes a number. */
export const LIBRARY_IMPORT_MAX_FILE_BYTES = {
  CSV: LIBRARY_IMPORT_LIMITS.maxBytes,
  XLSX: LIBRARY_IMPORT_XLSX_LIMITS.maxBytes,
} as const satisfies Record<LibraryImportFormat, number>

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
 * 8f-2: which stored resolution each status must carry — and, by omission,
 * which statuses must carry none. A `NEEDS_REVIEW` row holding a stale
 * resolution is exactly the bug this table exists to make unrepresentable.
 */
const READY_RESOLUTION_KIND = {
  READY_EXISTING_EDITION: 'EXISTING_EDITION',
  READY_CREATE_CHAIN: 'CREATE_CHAIN',
  NEEDS_REVIEW: undefined,
  INVALID: undefined,
  SKIPPED: undefined,
} as const satisfies Record<LibraryImportRowStatus, LibraryImportRowResolution['kind'] | undefined>

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
  'CONFLICTING_CATALOG_DATA',
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

/**
 * 8f-2: a local `Work` the row's book might already be, offered for an explicit
 * choice. Never auto-selected — agreed 8f-2 decision, see R7a.
 */
export const libraryImportCandidateSchema = z.strictObject({
  workId: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string().min(1)).max(CATALOG_LIMITS.authorsMax),
})

export type LibraryImportCandidate = z.infer<typeof libraryImportCandidateSchema>

/**
 * 8f-2: why a lookup produced no usable answer *this time*. Every reason here
 * is retryable — none of them means "no such book" (R7).
 */
export const LIBRARY_IMPORT_LOOKUP_UNAVAILABLE_REASON = [
  /** A provider answered with an error, or with a body we cannot trust. */
  'PROVIDER_ERROR',
  /** A provider did not answer within the lookup timeout. */
  'TIMEOUT',
  /** The per-preview fallback budget (R7a) was spent before this ISBN's turn. */
  'BUDGET_EXHAUSTED',
  /** A concurrent PATCH moved the row while this one was calling providers. */
  'CONCURRENT_UPDATE',
] as const

export const libraryImportLookupUnavailableReasonSchema = z.enum(
  LIBRARY_IMPORT_LOOKUP_UNAVAILABLE_REASON,
)

export type LibraryImportLookupUnavailableReason = z.infer<
  typeof libraryImportLookupUnavailableReasonSchema
>

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
  /**
   * 8f-2, R7: every provider finished its search and none knew this ISBN. A
   * timeout, an outage or a spent budget never lands here — those stay
   * `LOOKUP_UNAVAILABLE`, because "we could not ask" is not "there is no book".
   */
  z.strictObject({ code: z.literal('LOOKUP_NOT_FOUND') }),
  z.strictObject({
    code: z.literal('LOOKUP_UNAVAILABLE'),
    reason: libraryImportLookupUnavailableReasonSchema,
    /** Always `true`: the literal keeps the client from inventing a non-retryable variant. */
    retryable: z.literal(true),
  }),
  /**
   * 8f-2: the row (plus whatever lookup added) still cannot describe a full
   * `Work → Translation → Edition` chain. `fields` names the CSV columns to fill.
   */
  z.strictObject({
    code: z.literal('MISSING_CATALOG_DATA'),
    fields: z.array(libraryImportCsvColumnSchema).min(1).max(LIBRARY_IMPORT_CSV_HEADER.length),
  }),
  /**
   * 8f-2 (agreed): every value is valid on its own, but together they do not
   * describe one book — a row whose edition language equals the work's original
   * language while naming a translator, say. Distinct from `MISSING_CATALOG_DATA`
   * on purpose: nothing is missing here, something has to be decided, and the UI
   * must not tell a person to fill in what they already filled in.
   */
  z.strictObject({
    code: z.literal('CONFLICTING_CATALOG_DATA'),
    fields: z.array(libraryImportCsvColumnSchema).min(2).max(LIBRARY_IMPORT_CSV_HEADER.length),
  }),
  /**
   * 8f-2 (agreed): the catalog already holds works that may be this book, so the
   * owner picks one or explicitly asks for a new `Work`. Even a single candidate
   * lands here — a namesake attached silently is worse than one question.
   */
  z.strictObject({
    code: z.literal('AMBIGUOUS_CATALOG_MATCH'),
    candidates: z.array(libraryImportCandidateSchema).min(1).max(SEARCH_CANDIDATES_LIMIT),
  }),
])

export type LibraryImportRowError = z.infer<typeof libraryImportRowErrorSchema>

/**
 * 8f-4: why a reader could not turn one spreadsheet cell into a cell value.
 *
 * A CSV cell is text, so it either passes its field schema or does not, and the
 * text itself is the whole record of what went wrong. A spreadsheet cell is
 * typed, and a cell can hold something no text would have expressed — a date
 * where a count belongs, a number that cannot be written out exactly. We refuse
 * to invent text for those, which leaves the cell empty; without this record
 * the emptiness would look like "not given" and quietly take the column's
 * default on the next edit of some other column.
 *
 * So the rejection is stored beside the row and survives every action but one:
 * editing that very column. It is cleared by a correction, never by a default.
 */
export const LIBRARY_IMPORT_CELL_REJECTION = [
  /** A date in a column that is not `acquired_at`. */
  'UNEXPECTED_DATE',
  /** An `acquired_at` date inside Excel's 1900 leap-year fiction. */
  'DATE_OUT_OF_RANGE',
  /** A number we cannot write out plainly and exactly, an imprecise ISBN included. */
  'UNREPRESENTABLE_NUMBER',
] as const

export const libraryImportCellRejectionSchema = z.enum(LIBRARY_IMPORT_CELL_REJECTION)

export type LibraryImportCellRejection = z.infer<typeof libraryImportCellRejectionSchema>

export const libraryImportRejectedCellsSchema = z.partialRecord(
  libraryImportCsvColumnSchema,
  libraryImportCellRejectionSchema,
)

export type LibraryImportRejectedCells = z.infer<typeof libraryImportRejectedCellsSchema>

// --- Resolution (8f-2) --------------------------------------------------------

/**
 * 8f-2: what a `READY_*` row would create, decided at preview time and stored so
 * that 8g commits exactly what the owner reviewed — and so that `GET` can answer
 * from the draft alone, without calling a provider again.
 *
 * The chain of §3 stays four entities here too: the `Work` half is shared
 * metadata, the `Edition` half belongs to this one ISBN.
 */
export const libraryImportResolvedWorkSchema = z.strictObject({
  title: titleSchema,
  /** R4: every name gets the `AUTHOR` role; order is the order given. */
  authors: authorsSchema,
  origLang: languageCodeSchema,
  firstPubYear: yearSchema.nullable(),
})

export const libraryImportResolvedTranslationSchema = z.strictObject({
  translator: translatorSchema,
  lang: languageCodeSchema,
  sourceLang: languageCodeSchema,
  year: yearSchema.nullable(),
  isAbridged: z.boolean(),
  hasNotes: z.boolean(),
  notes: translationNotesSchema.nullable(),
})

export const libraryImportResolvedEditionSchema = z.strictObject({
  isbn13: isbn13Schema,
  publisher: publisherSchema.nullable(),
  year: yearSchema.nullable(),
  pageCount: pageCountSchema.nullable(),
  coverUrl: coverUrlSchema.nullable(),
  format: editionFormatSchema,
})

/** `translation` is `null` exactly for an edition in the work's original language. */
export const libraryImportResolvedCatalogSchema = z.strictObject({
  work: libraryImportResolvedWorkSchema,
  translation: libraryImportResolvedTranslationSchema.nullable(),
  edition: libraryImportResolvedEditionSchema,
})

export type LibraryImportResolvedCatalog = z.infer<typeof libraryImportResolvedCatalogSchema>

export const libraryImportRowResolutionSchema = z.discriminatedUnion('kind', [
  /** The exact ISBN is already in the catalog: 8g adds a `Copy` and nothing else. */
  z.strictObject({
    kind: z.literal('EXISTING_EDITION'),
    editionId: z.string().min(1),
    workId: z.string().min(1),
  }),
  /**
   * Valid data and a settled decision — NOT a catalog write. `workId` is the
   * existing `Work` the owner chose, or `null` for "create a new one".
   */
  z.strictObject({
    kind: z.literal('CREATE_CHAIN'),
    workId: z.string().min(1).nullable(),
    catalog: libraryImportResolvedCatalogSchema,
  }),
])

export type LibraryImportRowResolution = z.infer<typeof libraryImportRowResolutionSchema>

/**
 * What one draft row stores. `values` is `null` exactly when a field failed to
 * parse; the raw file itself is never stored, only these per-row cells, which
 * are deleted with the row on expiry or commit.
 *
 * `resolution` is `null` until 8f-2 resolves the row, and again whenever an edit
 * invalidates it: a row that changed its ISBN must not keep pointing at the
 * `Edition` the old one resolved to.
 */
export const libraryImportRowVersionSchema = z.string().min(1).max(64)

export const libraryImportRowPayloadSchema = z
  .strictObject({
    cells: libraryImportCsvCellsSchema,
    values: libraryImportRowValuesSchema.nullable(),
    errors: z.array(libraryImportRowErrorSchema).max(LIBRARY_IMPORT_CSV_HEADER.length),
    resolution: libraryImportRowResolutionSchema.nullable().default(null),
    /**
     * 8f-4: cells a reader refused, by column. `.default({})` so every row
     * stored before this stage still parses — a CSV never produces any.
     */
    rejectedCells: libraryImportRejectedCellsSchema.default({}),
    /**
     * 8f-2 (agreed): an opaque token identifying THIS state of the row.
     *
     * Minted fresh whenever an explicit action changes the row, and for every
     * row of a newly created or revived draft. Deliberately opaque rather than a
     * hash of the content: an edit that goes A → B → A has to conflict with an
     * operation that read A, and a content hash would call that "unchanged".
     * Recomputing derived state (statuses, duplicates, readiness) for the other
     * rows does NOT mint new tokens — those rows were not acted on.
     */
    rowVersion: libraryImportRowVersionSchema,
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
    const { errors, values, resolution } = row.payload
    const expectedResolution = READY_RESOLUTION_KIND[row.status]

    if (resolution?.kind !== expectedResolution) {
      context.addIssue({
        code: 'custom',
        message: `Status ${row.status} requires resolution ${String(expectedResolution)}`,
        path: ['payload', 'resolution'],
      })
    }

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

/**
 * `REQUEST_BYTES` is the transport cap, not a file rule: it fires before the
 * body is read, so the CSV's own size is not known yet and must not be guessed
 * from the request length (base64 plus a JSON envelope is not the file).
 */
export const LIBRARY_IMPORT_SIZE_LIMIT = [
  'BYTES',
  'ROWS',
  'COPIES',
  'REQUEST_BYTES',
  /** 8f-4, XLSX only: the ZIP's real decompressed total. */
  'UNCOMPRESSED_BYTES',
  'ZIP_ENTRIES',
  /** Reported as a whole number — the ratio rounded up, so `actual` stays an integer. */
  'COMPRESSION_RATIO',
  'SHEETS',
  'CELLS',
  /** Rows present in a sheet's markup, empty ones included. */
  'SHEET_ROWS',
] as const

const positiveCount = z.number().int().positive()

/** `details` of `IMPORT_TOO_LARGE`. */
export const libraryImportTooLargeDetailsSchema = z.discriminatedUnion('limit', [
  z.strictObject({
    limit: z.enum([
      'BYTES',
      'ROWS',
      'COPIES',
      'UNCOMPRESSED_BYTES',
      'ZIP_ENTRIES',
      'COMPRESSION_RATIO',
      'SHEETS',
      'CELLS',
      'SHEET_ROWS',
    ]),
    max: positiveCount,
    actual: positiveCount,
  }),
  z.strictObject({
    limit: z.literal('REQUEST_BYTES'),
    max: positiveCount,
    /** Absent when the client sent no `Content-Length`: unknown, not zero. */
    actual: positiveCount.optional(),
  }),
])

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

/**
 * 8f-4: why an `.xlsx` is not a library import. Separate from the CSV reasons
 * because none of them overlap: a workbook has no delimiter and a CSV has no
 * sheets, and one union covering both would force every reader of it to ask
 * which half it is looking at.
 */
export const LIBRARY_IMPORT_INVALID_XLSX_REASON = [
  /** Not a ZIP container at all. */
  'NOT_A_ZIP',
  /**
   * A legacy `.xls` or a password-protected workbook (agreed PO wording). One
   * reason for both on purpose: telling them apart would take guesswork inside
   * a compound-file container, and a confident wrong answer is worse than an
   * honest one that names both and says what to do.
   */
  'UNSUPPORTED_CONTAINER',
  /** `.xlsm`: a macro part is present, whatever the file is named. */
  'MACRO_ENABLED',
  /** The workbook pulls data from another file; that data is not in front of us. */
  'EXTERNAL_LINKS',
  /** A member we do not read and will not pass on — content type or relationship. */
  'FORBIDDEN_PART',
  /** Two members with the same path: which one is "the" sheet is not ours to guess. */
  'DUPLICATE_ENTRY',
  /** A member path that escapes the archive, is absolute, or is otherwise unsafe. */
  'UNSAFE_ENTRY_PATH',
  /** The ZIP is structurally broken, or its declared sizes are not the real ones. */
  'MALFORMED_ZIP',
  /** A valid ZIP that is not a workbook we can read. */
  'MALFORMED_XLSX',
  /** No sheet holds any data. A sheet that is merely styled is not a data sheet. */
  'NO_SHEET',
  /** More than one sheet holds data — the owner says which, we never pick (agreed). */
  'MULTIPLE_SHEETS',
  'HEADER_MISMATCH',
  /** A formula: refused outright, and its cached result is not read as data. */
  'FORMULA_CELL',
  /** An Excel error value (`#REF!`, `#N/A`, …) — distinct from a formula (agreed). */
  'CELL_ERROR',
  /** Header present, not one data row under it. */
  'EMPTY',
] as const

/**
 * A 1-based sheet position, never the sheet's name.
 *
 * Same rule as R6a's `unknownColumnPositions`: an error names a location, not
 * file content. A sheet name is something the owner typed, and it has no
 * business travelling back through an error body into a log.
 */
const sheetIndexSchema = z.number().int().positive().max(LIBRARY_IMPORT_XLSX_LIMITS.maxSheets)

/** 1-based spreadsheet coordinates — the row and column as Excel numbers them. */
const cellLocationSchema = {
  sheet: sheetIndexSchema,
  row: positiveCount,
  column: positiveCount,
}

export const libraryImportInvalidXlsxDetailsSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('NOT_A_ZIP') }),
  z.strictObject({ reason: z.literal('UNSUPPORTED_CONTAINER') }),
  z.strictObject({ reason: z.literal('MACRO_ENABLED') }),
  z.strictObject({ reason: z.literal('EXTERNAL_LINKS') }),
  z.strictObject({ reason: z.literal('FORBIDDEN_PART') }),
  z.strictObject({ reason: z.literal('DUPLICATE_ENTRY') }),
  z.strictObject({ reason: z.literal('UNSAFE_ENTRY_PATH') }),
  z.strictObject({ reason: z.literal('MALFORMED_ZIP') }),
  z.strictObject({ reason: z.literal('MALFORMED_XLSX') }),
  z.strictObject({ reason: z.literal('NO_SHEET') }),
  /** How many sheets carry data, so the message can say "leave one of N". */
  z.strictObject({
    reason: z.literal('MULTIPLE_SHEETS'),
    sheets: z.array(sheetIndexSchema).min(2),
  }),
  z.strictObject({
    reason: z.literal('HEADER_MISMATCH'),
    sheet: sheetIndexSchema,
    missingColumns: z.array(libraryImportCsvColumnSchema),
    duplicateColumns: z.array(libraryImportCsvColumnSchema),
    unknownColumnPositions: z.array(positiveCount),
    orderMismatch: z.boolean(),
  }),
  z.strictObject({ reason: z.literal('FORMULA_CELL'), ...cellLocationSchema }),
  z.strictObject({ reason: z.literal('CELL_ERROR'), ...cellLocationSchema }),
  z.strictObject({ reason: z.literal('EMPTY'), sheet: sheetIndexSchema }),
])

export type LibraryImportInvalidXlsxDetails = z.infer<typeof libraryImportInvalidXlsxDetailsSchema>

// --- HTTP contracts (8f-2) ------------------------------------------------------

/**
 * Standard base64 (RFC 4648 §4), padded, nothing else: no base64url alphabet, no
 * `data:` prefix, no whitespace or newlines. `Buffer.from(…, 'base64')` accepts
 * all of those silently and drops what it cannot read, so a file that arrived
 * corrupted would hash and parse as a *different, shorter* file. The check has
 * to happen before the decode, not after it.
 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Base64 of `maxRequestBytes`: 4 characters per 3 bytes, rounded up to a whole quantum. */
export const LIBRARY_IMPORT_CONTENT_BASE64_MAX =
  Math.ceil(LIBRARY_IMPORT_LIMITS.maxRequestBytes / 3) * 4

/**
 * The CSV travels as base64 inside JSON (agreed 8f-2 decision): the bytes reach
 * the parser exactly as sent — BOM, line endings and all — which is what R6a's
 * byte-level rules (48 KiB as received, `INVALID_ENCODING`, `sourceHash`) are
 * defined on, while the request itself stays an ordinary schema-validated DTO.
 */
export const libraryImportPreviewRequestSchema = z.strictObject({
  /**
   * 8f-4: omitted means `CSV`, so every 8f-2 client keeps working unchanged.
   * `.default()` and not `.optional()`: absent is the only thing that becomes
   * `CSV`. An explicit `null`, an empty string or an unknown name is a
   * validation error — a client that tried to say something we did not
   * understand must be told so, not quietly given the other format.
   */
  format: libraryImportFormatSchema.default('CSV'),
  contentBase64: z
    .string()
    .min(1)
    .max(LIBRARY_IMPORT_CONTENT_BASE64_MAX)
    .regex(BASE64_PATTERN, 'Очікується стандартний base64 без пробілів і префіксів'),
})

export type LibraryImportPreviewRequest = z.infer<typeof libraryImportPreviewRequestSchema>

export const libraryImportRowResponseSchema = z.strictObject({
  rowNumber: libraryImportRowNumberSchema,
  status: libraryImportRowStatusSchema,
  /** Send it back as `expectedRowVersion` to act on exactly the row you were shown. */
  rowVersion: libraryImportRowVersionSchema,
  /** The row exactly as the file spelled it — what an `INVALID` row shows for correction. */
  cells: libraryImportCsvCellsSchema,
  values: libraryImportRowValuesSchema.nullable(),
  errors: z.array(libraryImportRowErrorSchema).max(LIBRARY_IMPORT_CSV_HEADER.length),
  resolution: libraryImportRowResolutionSchema.nullable(),
  /**
   * Which cells the reader refused and why, so the UI can say what was in a
   * cell it is showing as empty instead of just calling the column invalid.
   */
  rejectedCells: libraryImportRejectedCellsSchema,
})

export type LibraryImportRowResponse = z.infer<typeof libraryImportRowResponseSchema>

export const libraryImportSummaryResponseSchema = z.strictObject({
  id: z.string().min(1),
  status: libraryImportStatusSchema,
  rowCount: z.number().int().min(0).max(LIBRARY_IMPORT_LIMITS.maxDataRows),
  /** Copies the file asked for, as counted at parse time (R6a). */
  copyCount: z.number().int().min(0).max(LIBRARY_IMPORT_LIMITS.maxCopies),
  /** Set by the commit (8g); `null` while the import is a draft. */
  createdCopyCount: z.number().int().min(0).nullable(),
  expiresAt: z.iso.datetime(),
  committedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

/** One entry per row status, recomputed after every edit — never a client-side tally. */
export const libraryImportCountsSchema = z.strictObject({
  readyExistingEdition: z.number().int().min(0),
  readyCreateChain: z.number().int().min(0),
  needsReview: z.number().int().min(0),
  invalid: z.number().int().min(0),
  skipped: z.number().int().min(0),
})

export type LibraryImportCounts = z.infer<typeof libraryImportCountsSchema>

// --- Commit (8g) ---------------------------------------------------------------

/**
 * 8g, R6c: why a draft cannot be committed as it stands.
 *
 * One `IMPORT_NOT_READY` code with typed reasons rather than seven codes: to a
 * client they all mean the same thing — this draft is not importable right now,
 * these are the rows — and they are all answered the same way. Splitting them
 * would buy seven branches of identical handling.
 *
 * The first three are decided from the draft alone, so `readiness.blockers`
 * carries them and the owner sees the problem before pressing anything. The
 * rest can only be known at commit time, under the import lock, against the
 * catalog as it is at that instant.
 */
export const LIBRARY_IMPORT_NOT_READY_REASON = [
  /** Rows that are still `NEEDS_REVIEW` or `INVALID`. */
  'ROWS_UNRESOLVED',
  /** Every row is skipped, so a commit would create nothing at all. */
  'NOTHING_TO_IMPORT',
  /**
   * Rows sharing one new ISBN disagree about what to create — a different
   * resolved catalog, or a different chosen `Work` (a new one against an
   * existing one counts, even when the metadata match).
   */
  'CONFLICTING_EDITION_ROWS',
  /** The draft changed after the client read the `draftVersion` it sent. */
  'DRAFT_CHANGED',
  /** A chosen `Work` was merged away between the choice and the commit. */
  'WORK_MERGED',
  /** A chosen `Work` is written in another original language than the row says. */
  'WORK_LANG_MISMATCH',
  /** An `Edition` with this ISBN appeared between the preview and the commit. */
  'EDITION_APPEARED',
] as const

export const libraryImportNotReadyReasonSchema = z.enum(LIBRARY_IMPORT_NOT_READY_REASON)

export type LibraryImportNotReadyReason = z.infer<typeof libraryImportNotReadyReasonSchema>

/** Which rows a reason is about. Row NUMBERS only — never a cell of their content. */
const blockedRowNumbersSchema = z
  .array(libraryImportRowNumberSchema)
  .min(1)
  .max(LIBRARY_IMPORT_LIMITS.maxDataRows)

export const libraryImportNotReadyDetailsSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('ROWS_UNRESOLVED'), rowNumbers: blockedRowNumbersSchema }),
  z.strictObject({ reason: z.literal('NOTHING_TO_IMPORT') }),
  z.strictObject({
    reason: z.literal('CONFLICTING_EDITION_ROWS'),
    rowNumbers: blockedRowNumbersSchema,
  }),
  z.strictObject({ reason: z.literal('DRAFT_CHANGED') }),
  z.strictObject({ reason: z.literal('WORK_MERGED'), rowNumbers: blockedRowNumbersSchema }),
  z.strictObject({ reason: z.literal('WORK_LANG_MISMATCH'), rowNumbers: blockedRowNumbersSchema }),
  z.strictObject({ reason: z.literal('EDITION_APPEARED'), rowNumbers: blockedRowNumbersSchema }),
])

export type LibraryImportNotReadyDetails = z.infer<typeof libraryImportNotReadyDetailsSchema>

/**
 * 8g, R6c: which state of the WHOLE draft a commit was decided on.
 *
 * Derived from the ordered `rowNumber:rowVersion` pairs, so it changes exactly
 * when some row's minted version changes and never merely because derived state
 * was recomputed. It is not a hash of the draft's content: `rowVersion` tokens
 * are minted rather than computed, which is what makes an A → B → A edit
 * produce a different value here — the same property R7a requires per row.
 */
export const libraryImportDraftVersionSchema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * R5: commit is allowed only once every row is `READY_*` or `SKIPPED`, and only
 * if something is actually left to create. `copyCount` here is the live sum over
 * the rows that would be committed — not the parse-time figure in the summary.
 */
export const libraryImportReadinessSchema = z.strictObject({
  canCommit: z.boolean(),
  /**
   * 8g, R6c: everything standing between this draft and a commit, computed by
   * the very same function the commit re-runs under its lock — so the button
   * and the endpoint cannot disagree about whether the draft is ready.
   *
   * Empty does not by itself mean `canCommit`: exceeding the 500-copy cap keeps
   * its own `IMPORT_TOO_LARGE` answer (R6a) and is visible as `copyCount`
   * rather than as a blocker.
   */
  blockers: z.array(libraryImportNotReadyDetailsSchema),
  /**
   * Deliberately NOT capped at `maxCopies`. Editing can carry a draft past the
   * cap — a row whose quantity was invalid counted for nothing at parse time
   * (R6a) and adds its copies once fixed — and the honest answer is the real
   * number with `canCommit: false`, not a figure clipped to the limit it just
   * broke. The bound here is only what a draft can physically reach.
   */
  copyCount: z
    .number()
    .int()
    .min(0)
    .max(LIBRARY_IMPORT_LIMITS.maxDataRows * LIBRARY_IMPORT_LIMITS.quantityMax),
})

export type LibraryImportReadiness = z.infer<typeof libraryImportReadinessSchema>

/**
 * R12: one document for the whole draft — summary, counts, readiness and rows
 * together. `PATCH` answers with this same shape, so the row table and the
 * commit button can never come from two different sources.
 *
 * `rows` is empty for an `EXPIRED` or `COMMITTED` import: their payloads (the
 * private `note` included) are deleted, and only the summary survives.
 */
export const libraryImportDraftResponseSchema = z.strictObject({
  import: libraryImportSummaryResponseSchema,
  counts: libraryImportCountsSchema,
  readiness: libraryImportReadinessSchema,
  /**
   * 8g: send it back as `expectedDraftVersion` to commit exactly the draft you
   * were shown. Present on every answer, an `EXPIRED` or `COMMITTED` one
   * included — where it is the version of an empty set of rows, which is all
   * such an import has left.
   */
  draftVersion: libraryImportDraftVersionSchema,
  rows: z.array(libraryImportRowResponseSchema).max(LIBRARY_IMPORT_LIMITS.maxDataRows),
})

export type LibraryImportDraftResponse = z.infer<typeof libraryImportDraftResponseSchema>

/**
 * 8f-2: one discriminated request for every way a row changes. Each action
 * answers with the whole recomputed draft — validation, duplicates, counts and
 * readiness are re-derived server side, never patched in place by the client.
 */
export const LIBRARY_IMPORT_ROW_ACTION = [
  /** Replace some cells; the row re-parses and re-resolves exactly as a fresh file would. */
  'EDIT',
  /** Settle `AMBIGUOUS_CATALOG_MATCH`: an offered `Work`, or `null` for a new one. */
  'CHOOSE',
  'SKIP',
  /** Undo a skip and resolve the row again from its stored cells. */
  'RESTORE',
  /** Run resolution again — for a provider outage or a spent fallback budget (R7a). */
  'RETRY',
] as const

export const libraryImportRowActionSchema = z.enum(LIBRARY_IMPORT_ROW_ACTION)

export type LibraryImportRowAction = z.infer<typeof libraryImportRowActionSchema>

/**
 * Edited cells are raw strings, not typed values, and that is the point: they go
 * through the very same cell schemas the CSV does, so an edit cannot reach a
 * state a file could not. An omitted column keeps its stored cell; `''` means
 * "not given" exactly as in the file (R6a).
 */
export const libraryImportEditCellsSchema = z
  .partialRecord(libraryImportCsvColumnSchema, z.string().max(LIBRARY_IMPORT_LIMITS.maxBytes))
  .refine((cells) => Object.keys(cells).length > 0, 'Не передано жодної клітинки для зміни')

/**
 * Which row state the client is acting on (agreed 8f-2 concurrency contract).
 *
 * Required on every action, including the ones that make no external call: the
 * point is not the provider but the intent. An operation computed from a row a
 * person saw must not land on a row someone — or they themselves, in another
 * tab — has changed since, and only the client can say which state it meant.
 */
const expectedRowVersionSchema = libraryImportRowVersionSchema

export const libraryImportRowPatchRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('EDIT'),
    expectedRowVersion: expectedRowVersionSchema,
    cells: libraryImportEditCellsSchema,
  }),
  z.strictObject({
    action: z.literal('CHOOSE'),
    expectedRowVersion: expectedRowVersionSchema,
    workId: z.string().min(1).nullable(),
  }),
  z.strictObject({ action: z.literal('SKIP'), expectedRowVersion: expectedRowVersionSchema }),
  z.strictObject({ action: z.literal('RESTORE'), expectedRowVersion: expectedRowVersionSchema }),
  z.strictObject({ action: z.literal('RETRY'), expectedRowVersion: expectedRowVersionSchema }),
])

export type LibraryImportRowPatchRequest = z.infer<typeof libraryImportRowPatchRequestSchema>

/**
 * 8g, R6c: the one thing a commit carries.
 *
 * Required, for the same reason `expectedRowVersion` is required on every row
 * action: the import lock only makes concurrent operations take turns, it does
 * not make the second one still right. A commit decided on the draft as it
 * looked before someone's other tab skipped a row is a commit of something
 * nobody reviewed.
 *
 * A repeated commit of an import that already succeeded never reaches this
 * check — an answered `COMMITTED` is returned first (R6c), which is what makes
 * a retry after a lost response work even once the rows, and with them every
 * `rowVersion` the client could echo, are gone.
 */
export const libraryImportCommitRequestSchema = z.strictObject({
  expectedDraftVersion: libraryImportDraftVersionSchema,
})

export type LibraryImportCommitRequest = z.infer<typeof libraryImportCommitRequestSchema>
