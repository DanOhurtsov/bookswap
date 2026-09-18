import {
  libraryImportCsvCellsSchema,
  libraryImportCsvRowSchema,
  LIBRARY_IMPORT_CSV_HEADER,
  type BookLookupResult,
  type LibraryImportCsvCells,
  type LibraryImportRowValues,
} from '@bookswap/shared'
import { buildResolvedCatalog } from './library-import.resolution'

/**
 * Stage 8f-2: what a row would create, and — just as important — what it
 * refuses to invent when the data is not there.
 */

const VALID_ISBN = '9780306406157'

function values(overrides: Partial<LibraryImportCsvCells> = {}): LibraryImportRowValues {
  const empty = Object.fromEntries(LIBRARY_IMPORT_CSV_HEADER.map((column) => [column, '']))
  const cells = libraryImportCsvCellsSchema.parse({ ...empty, isbn13: VALID_ISBN, ...overrides })

  return libraryImportCsvRowSchema.parse(cells)
}

const FULL_ORIGINAL: Partial<LibraryImportCsvCells> = {
  title: 'Dune',
  authors: 'Frank Herbert',
  orig_lang: 'en',
  edition_lang: 'en',
}

describe('buildResolvedCatalog', () => {
  it('builds an original-language chain from the file alone', () => {
    const assembly = buildResolvedCatalog(values(FULL_ORIGINAL), undefined)

    expect(assembly).toEqual({
      kind: 'complete',
      catalog: {
        work: { title: 'Dune', authors: ['Frank Herbert'], origLang: 'en', firstPubYear: null },
        translation: null,
        edition: {
          isbn13: VALID_ISBN,
          publisher: null,
          year: null,
          pageCount: null,
          coverUrl: null,
          format: 'PAPERBACK',
        },
      },
    })
  })

  /**
   * The direction of the merge is the whole point: a person who typed a
   * publisher into their file meant that publisher, whatever Open Library says.
   */
  it('lets the file win over the provider and fills only the gaps', () => {
    const lookup: BookLookupResult = {
      title: 'Dune (provider)',
      authors: ['Somebody Else'],
      publisher: 'Provider House',
      publishedYear: 2005,
      pageCount: 700,
      coverUrl: 'https://covers.example.com/dune.jpg',
    }
    const assembly = buildResolvedCatalog(
      values({ ...FULL_ORIGINAL, publisher: 'Клуб сімейного дозвілля' }),
      lookup,
    )

    expect(assembly).toMatchObject({
      kind: 'complete',
      catalog: {
        work: { title: 'Dune', authors: ['Frank Herbert'] },
        edition: {
          publisher: 'Клуб сімейного дозвілля',
          year: 2005,
          pageCount: 700,
          coverUrl: 'https://covers.example.com/dune.jpg',
        },
      },
    })
  })

  it('takes title and authors from the provider when the file left them empty', () => {
    const assembly = buildResolvedCatalog(values({ orig_lang: 'en', edition_lang: 'en' }), {
      title: 'Dune',
      authors: ['Frank Herbert'],
    })

    expect(assembly).toMatchObject({
      kind: 'complete',
      catalog: { work: { title: 'Dune', authors: ['Frank Herbert'] } },
    })
  })

  it('names the columns still missing instead of guessing them', () => {
    expect(buildResolvedCatalog(values(), undefined)).toEqual({
      kind: 'incomplete',
      missing: ['title', 'authors', 'orig_lang'],
    })
  })

  /**
   * `language` from a provider describes the edition someone is holding, never
   * the language a work was written in — so it must not become `origLang`.
   */
  it('never lets a provider language stand in for the original language', () => {
    const assembly = buildResolvedCatalog(values({ title: 'Dune', authors: 'Frank Herbert' }), {
      title: 'Dune',
      language: 'en',
    })

    expect(assembly).toEqual({ kind: 'incomplete', missing: ['orig_lang'] })
  })

  /**
   * A Ukrainian edition is not evidence that the work was written in Ukrainian,
   * and "no translation cells" is not evidence either — an earlier version
   * inferred exactly that and would have created works in the wrong original
   * language from any file that left `orig_lang` empty.
   */
  it('never infers the original language from the edition language', () => {
    expect(
      buildResolvedCatalog(
        values({ title: 'Dune', authors: 'F H', edition_lang: 'uk' }),
        undefined,
      ),
    ).toEqual({ kind: 'incomplete', missing: ['orig_lang'] })
  })

  it('demands a translator once the edition language differs from the original', () => {
    expect(
      buildResolvedCatalog(
        values({ title: 'Dune', authors: 'F H', orig_lang: 'en', edition_lang: 'uk' }),
        undefined,
      ),
    ).toEqual({ kind: 'incomplete', missing: ['translator'] })
  })

  it('assembles a translation and defaults its source language to the original', () => {
    const assembly = buildResolvedCatalog(
      values({
        title: 'Dune',
        authors: 'F H',
        orig_lang: 'en',
        edition_lang: 'uk',
        translator: 'Анатолій Пітик',
        translation_year: '2020',
        is_abridged: 'true',
      }),
      undefined,
    )

    expect(assembly).toMatchObject({
      kind: 'complete',
      catalog: {
        translation: {
          translator: 'Анатолій Пітик',
          lang: 'uk',
          sourceLang: 'en',
          year: 2020,
          isAbridged: true,
          hasNotes: false,
          notes: null,
        },
      },
    })
  })

  /**
   * Provider data is outside data. A title longer than the column allows has to
   * come back as "fix this cell", not as a 500 at commit time.
   */
  it('reports the column to fix when provider data does not fit the domain', () => {
    const assembly = buildResolvedCatalog(values({ orig_lang: 'en', edition_lang: 'en' }), {
      title: 'Д'.repeat(400),
      authors: ['Frank Herbert'],
    })

    expect(assembly).toEqual({ kind: 'incomplete', missing: ['title'] })
  })
})

/**
 * Agreed 8f-2 rule: values that are each valid but do not describe one book ask
 * for a DECISION, not for more data — and nothing the file says is dropped on
 * the way there.
 */
describe('суперечливі дані рядка', () => {
  it('перекладач у виданні мовою оригіналу — CONFLICTING_CATALOG_DATA', () => {
    const assembly = buildResolvedCatalog(
      values({ ...FULL_ORIGINAL, translator: 'Анатолій Пітик' }),
      undefined,
    )

    expect(assembly).toEqual({
      kind: 'conflicting',
      fields: ['edition_lang', 'translator'],
    })
  })

  it('перелічує всі задані translation-колонки, включно з boolean true', () => {
    const assembly = buildResolvedCatalog(
      values({
        ...FULL_ORIGINAL,
        translation_source_lang: 'de',
        translation_year: '2020',
        is_abridged: 'true',
        has_notes: 'true',
        translation_notes: 'Примітки',
      }),
      undefined,
    )

    expect(assembly).toEqual({
      kind: 'conflicting',
      fields: [
        'edition_lang',
        'translation_source_lang',
        'translation_year',
        'is_abridged',
        'has_notes',
        'translation_notes',
      ],
    })
  })

  /**
   * `is_abridged=false` says the book is not abridged — equally true of an
   * original. Reading it as a claim about translation would invent an intent
   * nobody expressed.
   */
  it('false у boolean не є доказом перекладу й не створює суперечності', () => {
    const assembly = buildResolvedCatalog(
      values({ ...FULL_ORIGINAL, is_abridged: 'false', has_notes: 'false' }),
      undefined,
    )

    expect(assembly).toMatchObject({ kind: 'complete', catalog: { translation: null } })
  })

  it('справжній переклад суперечності не має', () => {
    const assembly = buildResolvedCatalog(
      values({
        title: 'Dune',
        authors: 'F H',
        orig_lang: 'en',
        edition_lang: 'uk',
        translator: 'Анатолій Пітик',
        is_abridged: 'true',
      }),
      undefined,
    )

    expect(assembly).toMatchObject({
      kind: 'complete',
      catalog: { translation: { lang: 'uk', sourceLang: 'en', isAbridged: true } },
    })
  })

  /**
   * The provider filled in the edition language, and it matches the original —
   * so the translator the FILE names still has to be reconciled. Pointing at
   * `edition_lang` says what to state explicitly.
   */
  it('мова видання від провайдера теж може створити суперечність', () => {
    const assembly = buildResolvedCatalog(
      values({ title: 'Dune', authors: 'F H', orig_lang: 'en', translator: 'Хтось' }),
      { title: 'Dune', language: 'en' },
    )

    expect(assembly).toEqual({ kind: 'conflicting', fields: ['edition_lang', 'translator'] })
  })
})
