import { z } from 'zod'
import { editionFormatSchema } from '../domain/catalog'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'
import { catalogSearchRequestSchema } from './catalog'
import { bookLookupSourceSchema, type BookLookupResult } from './lookup'

/**
 * §6.3 step 1, agreed extension: searching external catalogs by TITLE, beside
 * the existing ISBN lookup (`./lookup.ts`).
 *
 * §6.3 describes external sources more narrowly ("the user enters an ISBN"),
 * so the scope of this extension lives in
 * `docs/plan/stage-9-external-title-search.md`, not in `docs/specification.md`.
 *
 * The boundary with `bookLookupResultSchema` is deliberate. That one answers
 * about a SPECIFIC ISBN, so it always describes one edition. This one returns a
 * list of candidates, and an external source may describe either one edition or
 * a work as a whole. Folding both into a single shape would attribute edition
 * fields (ISBN, publisher, printing year) to a work that no source ever
 * claimed — the exact mistake that makes Open Library unsafe to read naively
 * (see `kind` below).
 */

/**
 * How many external candidates to show.
 *
 * This is a "maybe your book is one of these" hint, not a catalog to page
 * through, so there is no pagination — the same reason as for
 * {@link SEARCH_CANDIDATES_LIMIT}. The cap also applies outwards: it becomes
 * the provider's `limit`/`maxResults`, so we never ask for more than we intend
 * to display.
 */
export const EXTERNAL_SEARCH_LIMIT = 12

/** The same `q` (min. 2 characters) as the local search — one input field. */
export const externalSearchRequestSchema = catalogSearchRequestSchema

export type ExternalSearchRequest = z.infer<typeof externalSearchRequestSchema>

/**
 * What an external record actually talks about.
 *
 * `EDITION` — the source describes one printing: it has its own ISBN,
 * publisher, year and page count (a Google Books volume).
 *
 * `WORK` — the source describes a work, not an edition (an Open Library
 * `search.json` document). Such a record carries no ISBN EVEN WHEN the
 * provider's answer contains an `isbn` array: that array aggregates every known
 * edition of the work, and taking any element of it would attribute a random
 * foreign printing to the book in the user's hands. The same goes for publisher
 * and printing year. The only year a work really has is its FIRST publication
 * year, and that lives in its own field — see `firstPublishedYear` below.
 */
export const EXTERNAL_SEARCH_RECORD_KINDS = ['EDITION', 'WORK'] as const

export const externalSearchRecordKindSchema = z.enum(EXTERNAL_SEARCH_RECORD_KINDS)

export type ExternalSearchRecordKind = z.infer<typeof externalSearchRecordKindSchema>

/**
 * Fields that belong to an edition alone. Kept as a list because the
 * `superRefine` below forbids them on a `WORK` record, and this list is exactly
 * what it checks.
 */
const EDITION_ONLY_FIELDS = [
  'isbn13',
  'publisher',
  'publishedYear',
  'format',
  // Open Library reports `number_of_pages_median` — a median across every
  // edition of the work. That is not the thickness of the book in the user's
  // hands, so a `WORK` leaves the field empty rather than filling it with an
  // "approximately right" number.
  'pageCount',
] as const

/**
 * One external candidate.
 *
 * Everything but `id`, `kind`, `sources` and `title` is optional, and that is
 * not schema laxity but §6.3 item 7: an unknown value stays empty instead of
 * being replaced by a guess. A record without an ISBN is a normal result, not
 * an incomplete one.
 */
export const externalSearchResultSchema = z
  .object({
    /**
     * Stable within one response: `<SOURCE>:<externalId>`. The client needs it
     * as a list `key` and to identify the selected card. It is NOT a catalog
     * identifier and never becomes one — §6.3: "the external ID is not stored
     * as a dependency".
     */
    id: z.string().min(1),
    kind: externalSearchRecordKindSchema,
    /**
     * Every source that returned this same record, after duplicate merging.
     * An array rather than a single value: when Google Books and Open Library
     * describe the same book, one card with two sources beats two rows the user
     * has to compare by hand.
     */
    sources: z.array(bookLookupSourceSchema).min(1),
    title: z.string().min(1),
    authors: z.array(z.string().min(1)).optional(),
    /** `EDITION` only: the ISBN of this printing, never a per-work aggregate. */
    isbn13: isbn13Schema.optional(),
    /** Language of this record's text. Autofill target is `Translation.lang` alone. */
    language: languageCodeSchema.optional(),
    /** `EDITION` only: the year of this printing → `Edition.year`. */
    publishedYear: z.number().int().optional(),
    /**
     * The work's first publication year → `Work.firstPubYear`. Work-level, so
     * it is never derived from `publishedYear`.
     *
     * It may also appear on an `EDITION`: when a work record and exactly one
     * printing are merged (`mergeResults`), the printing keeps its own
     * `publishedYear` and additionally carries the work-level year the other
     * source contributed. The two stay separate fields precisely so that
     * neither can be mistaken for the other.
     */
    firstPublishedYear: z.number().int().optional(),
    publisher: z.string().optional(),
    pageCount: z.number().int().positive().max(20_000).optional(),
    format: editionFormatSchema.optional(),
    coverUrl: z.string().optional(),
    description: z.string().min(1).optional(),
    externalId: z.string().optional(),
    /** Open Library Work (`OL…W`) — reference metadata, never a FK. */
    workExternalId: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.kind !== 'WORK') return

    for (const field of EDITION_ONLY_FIELDS) {
      if (value[field] === undefined) continue

      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `A WORK record describes no single printing — field ${field} is meaningless here`,
      })
    }
  })

export type ExternalSearchResult = z.infer<typeof externalSearchResultSchema>

/**
 * How one source ended up in this response.
 *
 * A separate field because "found nothing" and "could not ask" are different
 * facts and must not look alike: in the first case the book is not there, in
 * the second it may well be. An empty `results` next to a non-`OK` status means
 * "unknown", not "absent".
 *
 * `RATE_LIMITED` is distinct from `ERROR` on purpose: it means OUR own outbound
 * throttle refused the call (`ProviderRateLimiter`), not that the provider
 * failed. Reporting our own back-pressure as a provider outage would send
 * someone debugging the wrong system — and it also tells the user something
 * different, namely that retrying shortly is worth it.
 */
export const EXTERNAL_SEARCH_SOURCE_STATUSES = ['OK', 'TIMEOUT', 'ERROR', 'RATE_LIMITED'] as const

export const externalSearchSourceStatusSchema = z.enum(EXTERNAL_SEARCH_SOURCE_STATUSES)

export type ExternalSearchSourceStatus = z.infer<typeof externalSearchSourceStatusSchema>

export const externalSearchSourceReportSchema = z.object({
  source: bookLookupSourceSchema,
  status: externalSearchSourceStatusSchema,
})

export type ExternalSearchSourceReport = z.infer<typeof externalSearchSourceReportSchema>

/**
 * The endpoint's response.
 *
 * `sources` is always present and describes EVERY source queried, including the
 * ones that failed. A partial failure still answers 200: one provider going
 * down must not take another one's results with it, let alone block manual
 * entry.
 */
export const externalSearchResponseSchema = z.object({
  results: z.array(externalSearchResultSchema).max(EXTERNAL_SEARCH_LIMIT),
  sources: z.array(externalSearchSourceReportSchema),
})

export type ExternalSearchResponse = z.infer<typeof externalSearchResponseSchema>

/**
 * An external candidate → the editable draft that prefills the wizard.
 *
 * Deliberately returns the existing `BookLookupResult`: the add-book wizard
 * (`WorkStep`/`TranslationStep`/`EditionStep`) has known how to prefill from
 * that shape since Stage 7b, and a second parallel autofill path would be
 * exactly the duplicated abstraction CLAUDE.md asks us to avoid.
 *
 * `firstPublishedYear` is NOT carried here, and that is not a loss: it is
 * work-level, whereas every year in `BookLookupResult` means `Edition.year` by
 * contract. It reaches `Work.firstPubYear` through its own channel — see
 * `newWorkFromExternal` in the web wizard — so the edition year can never
 * silently become the work's first publication year.
 */
export function externalSearchResultToLookup(result: ExternalSearchResult): BookLookupResult {
  const source = result.sources[0]

  const common = {
    title: result.title,
    ...(result.authors === undefined ? {} : { authors: result.authors }),
    ...(result.language === undefined ? {} : { language: result.language }),
    ...(result.coverUrl === undefined ? {} : { coverUrl: result.coverUrl }),
    ...(result.description === undefined ? {} : { description: result.description }),
    ...(source === undefined ? {} : { source }),
    ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
    ...(result.workExternalId === undefined ? {} : { workExternalId: result.workExternalId }),
  }

  if (result.kind === 'WORK') return common

  return {
    ...common,
    ...(result.publishedYear === undefined ? {} : { publishedYear: result.publishedYear }),
    ...(result.publisher === undefined ? {} : { publisher: result.publisher }),
    ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
    ...(result.format === undefined ? {} : { format: result.format }),
  }
}
