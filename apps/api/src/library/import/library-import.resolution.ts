import {
  libraryImportResolvedCatalogSchema,
  type BookLookupResult,
  type LibraryImportCsvColumn,
  type LibraryImportResolvedCatalog,
  type LibraryImportRowValues,
} from '@bookswap/shared'

/**
 * Stage 8f-2: what one row would create, worked out from the row itself plus
 * whatever an external lookup added. Pure — no DB, no HTTP, no clock.
 *
 * The merge direction is fixed and never negotiable: the file wins over the
 * provider. A person who wrote a publisher into their CSV means that publisher,
 * even when Open Library disagrees. The provider only fills gaps.
 */

export type CatalogAssembly =
  | { kind: 'complete'; catalog: LibraryImportResolvedCatalog }
  /** Which CSV columns still have to be filled in for this row to be committable. */
  | { kind: 'incomplete'; missing: LibraryImportCsvColumn[] }
  /**
   * Every value is valid on its own, but the combination is not one book — so
   * the owner has to decide, not fill something in (agreed 8f-2 rule).
   */
  | { kind: 'conflicting'; fields: LibraryImportCsvColumn[] }

/**
 * Where each resolved field came from in the CSV — used to turn a schema issue
 * path back into the column a person has to edit.
 */
const COLUMN_BY_PATH: Readonly<Record<string, LibraryImportCsvColumn>> = {
  'work.title': 'title',
  'work.authors': 'authors',
  'work.origLang': 'orig_lang',
  'work.firstPubYear': 'first_pub_year',
  'translation.translator': 'translator',
  'translation.lang': 'edition_lang',
  'translation.sourceLang': 'translation_source_lang',
  'translation.year': 'translation_year',
  'translation.isAbridged': 'is_abridged',
  'translation.hasNotes': 'has_notes',
  'translation.notes': 'translation_notes',
  'edition.isbn13': 'isbn13',
  'edition.publisher': 'publisher',
  'edition.year': 'edition_year',
  'edition.pageCount': 'page_count',
  'edition.coverUrl': 'cover_url',
  'edition.format': 'format',
}

/**
 * Columns whose value ASSERTS that this edition is a translation.
 *
 * A boolean counts only when it is `true`: `is_abridged=false` says the book is
 * not abridged, which is equally true of an original — reading it as evidence
 * of a translation would invent an intent nobody expressed. A `false` is still
 * never silently dropped; it simply carries no claim about the chain.
 */
function translationColumnsGiven(values: LibraryImportRowValues): LibraryImportCsvColumn[] {
  const given: LibraryImportCsvColumn[] = []

  if (values.translator !== undefined) given.push('translator')
  if (values.translationSourceLang !== undefined) given.push('translation_source_lang')
  if (values.translationYear !== undefined) given.push('translation_year')
  if (values.isAbridged === true) given.push('is_abridged')
  if (values.hasNotes === true) given.push('has_notes')
  if (values.translationNotes !== undefined) given.push('translation_notes')

  return given
}

export function buildResolvedCatalog(
  values: LibraryImportRowValues,
  lookup: BookLookupResult | undefined,
): CatalogAssembly {
  const missing: LibraryImportCsvColumn[] = []
  const title = values.title ?? lookup?.title
  const authors = values.authors ?? nonEmpty(lookup?.authors)
  /**
   * Only the file can say this. A provider's `language` describes the edition
   * in someone's hands, never the language a work was written in (see
   * `bookLookupResultSchema`), and `edition_lang` does not imply it either: a
   * Ukrainian edition is not evidence that the work was written in Ukrainian.
   * For a NEW `Work` an unknown original language is a question, not a default.
   */
  const origLang = values.origLang

  if (title === undefined) missing.push('title')
  if (authors === undefined) missing.push('authors')
  if (origLang === undefined) missing.push('orig_lang')

  if (title === undefined || authors === undefined || origLang === undefined) {
    return { kind: 'incomplete', missing }
  }

  // R4: the edition's own language falls back to the provider's, then to the
  // original.
  const editionLang = values.editionLang ?? lookup?.language ?? origLang
  const needsTranslation = editionLang !== origLang
  const translationGiven = translationColumnsGiven(values)

  if (needsTranslation && values.translator === undefined) {
    return { kind: 'incomplete', missing: ['translator'] }
  }

  // The row names a translator (or another translation fact) while its edition
  // reads as being in the original language. Both halves are valid; together
  // they are not one book, and dropping either half silently — as this used to
  // do — would import something the owner never described.
  if (!needsTranslation && translationGiven.length > 0) {
    return { kind: 'conflicting', fields: ['edition_lang', ...translationGiven] }
  }

  const candidate = {
    work: {
      title,
      authors,
      origLang,
      firstPubYear: values.firstPubYear ?? null,
    },
    translation:
      needsTranslation && values.translator !== undefined
        ? {
            translator: values.translator,
            lang: editionLang,
            // R4 leaves `translation_source_lang` optional: a translation with
            // nothing else said is a translation from the original language.
            sourceLang: values.translationSourceLang ?? origLang,
            year: values.translationYear ?? null,
            isAbridged: values.isAbridged ?? false,
            hasNotes: values.hasNotes ?? false,
            notes: values.translationNotes ?? null,
          }
        : null,
    edition: {
      isbn13: values.isbn13,
      publisher: values.publisher ?? lookup?.publisher ?? null,
      /** The provider's year is this edition's, never the work's first (see `lookup.ts`). */
      year: values.editionYear ?? lookup?.publishedYear ?? null,
      pageCount: values.pageCount ?? lookup?.pageCount ?? null,
      coverUrl: values.coverUrl ?? lookup?.coverUrl ?? null,
      format: values.format,
    },
  }

  const parsed = libraryImportResolvedCatalogSchema.safeParse(candidate)

  // Provider data is outside data: a 400-character title or a publisher longer
  // than the column allows must land on the owner as "fix this cell", not as a
  // 500 at commit time three screens later.
  if (!parsed.success) return { kind: 'incomplete', missing: columnsOfIssues(parsed.error.issues) }

  return { kind: 'complete', catalog: parsed.data }
}

function nonEmpty(authors: readonly string[] | undefined): string[] | undefined {
  return authors === undefined || authors.length === 0 ? undefined : [...authors]
}

function columnsOfIssues(
  issues: readonly { path: readonly PropertyKey[] }[],
): LibraryImportCsvColumn[] {
  const columns = new Set<LibraryImportCsvColumn>()

  for (const issue of issues) {
    const column = COLUMN_BY_PATH[issue.path.slice(0, 2).join('.')]

    if (column !== undefined) columns.add(column)
  }

  // A shape we cannot attribute to one cell is still a real problem; pointing at
  // the title is better than reporting an empty `fields` the UI cannot render.
  return columns.size > 0 ? [...columns] : ['title']
}
