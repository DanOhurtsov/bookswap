import type {
  AddSearchEditionItem,
  AddSearchOwnership,
  AddSearchWorkItem,
  BookLookupResult,
  BookLookupSource,
  EditionFormat,
  ExternalSearchResult,
  QuickAddTarget,
} from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import { externalIdentities, externalTarget } from './external-target'
import { manualPrefillParams } from './manual-form'
import { identitiesOf, isbnIdentity } from './quick-add-identities'
import { RECORD_PARAM } from './search-address-urls'

/** A result chosen on the add search (BS-114): what the dialog is about, as the list gave it. */
export type AddResultSubject =
  | { kind: 'EDITION'; item: AddSearchEditionItem }
  | { kind: 'WORK'; item: AddSearchWorkItem }
  | { kind: 'EXTERNAL'; result: ExternalSearchResult }
  | { kind: 'LOOKUP'; isbn: string; lookup: BookLookupResult }

export interface AddResultFact {
  label: string
  value: string
}

/** Where the data comes from — external sources keep their attribution. */
export type AddResultSource =
  | { kind: 'CATALOG' }
  | { kind: 'EXTERNAL'; sources: readonly BookLookupSource[] }
  | { kind: 'LOOKUP'; source: BookLookupSource | undefined }

export interface AddResultView {
  title: string
  /** `undefined` — the source named no author; nothing is made up. */
  authors: string | undefined
  coverUrl: string | undefined
  /**
   * Only what is known about this edition — language (by name), publisher, year, format (our catalog's
   * editions), ISBN — and, labelled apart, the work's first publication. The edition's year is never filled from the work's.
   */
  facts: AddResultFact[]
  source: AddResultSource
  /** What one press adds; `undefined` — nothing concrete to add, the dialog offers only refining. */
  quickAdd: { identities: string[]; target: QuickAddTarget } | undefined
  /** `WORK` — a work, not an edition; `NO_IDENTITY` — an edition the server cannot be pointed at. */
  refineReason: 'WORK' | 'NO_IDENTITY' | undefined
  /**
   * An external WORK record added as is (BS-114): one press adds the book, and the edition's publisher, year
   * and ISBN stay unknown until the person refines them.
   */
  editionUnknown: boolean
  /** The server's count of the person's own copies — only our catalog's editions have one. */
  ownership: AddSearchOwnership | undefined
  /** The form's own parameters for «Уточнити дані»; the search context is added by `manualFormHref`. */
  refine: URLSearchParams
}

function editionFacts(edition: {
  lang?: string | null | undefined
  publisher?: string | null | undefined
  year?: number | null | undefined
  format?: EditionFormat | null | undefined
  isbn13?: string | null | undefined
}): AddResultFact[] {
  const { lang, publisher, year, format, isbn13 } = edition
  const facts: [string, string | null | undefined][] = [
    ['Мова', typeof lang === 'string' ? languageName(lang) : undefined],
    ['Видавництво', publisher],
    ['Рік видання', typeof year === 'number' ? String(year) : undefined],
    // The vertical card no longer shows the format; the dialog keeps it.
    ['Формат', format === null || format === undefined ? undefined : EDITION_FORMAT_LABELS[format]],
    ['ISBN', isbn13],
  ]

  return facts.flatMap(([label, value]) =>
    typeof value === 'string' && value !== '' ? [{ label, value }] : [],
  )
}

function firstPublished(year: number | null | undefined): AddResultFact[] {
  return typeof year === 'number' ? [{ label: 'Уперше видано', value: String(year) }] : []
}

function joined(names: readonly string[] | undefined): string | undefined {
  return names === undefined || names.length === 0 ? undefined : names.join(', ')
}

/** The record a form is opened from belongs to its identity: two records may share every value. */
function withRecord(prefill: URLSearchParams, recordId: string): URLSearchParams {
  prefill.set(RECORD_PARAM, recordId)

  return prefill
}

function editionView(item: AddSearchEditionItem): AddResultView {
  const { edition, work, authors, ownership } = item

  return {
    title: work.title,
    authors: joined(authors.map((author) => author.name)),
    coverUrl: edition.coverUrl ?? undefined,
    facts: editionFacts(edition),
    source: { kind: 'CATALOG' },
    quickAdd: {
      identities: identitiesOf(item),
      target: { kind: 'EXISTING_EDITION', editionId: edition.id },
    },
    refineReason: undefined,
    editionUnknown: false,
    ownership,
    // The very edition and its work: refining it must never create a second one.
    refine: new URLSearchParams({ editionId: edition.id, workId: edition.workId }),
  }
}

function workView(item: AddSearchWorkItem): AddResultView {
  return {
    title: item.work.title,
    authors: joined(item.authors.map((author) => author.name)),
    // A work has no cover of its own: an edition's would be made up.
    coverUrl: undefined,
    facts: firstPublished(item.work.firstPubYear),
    source: { kind: 'CATALOG' },
    quickAdd: undefined,
    refineReason: 'WORK',
    editionUnknown: false,
    ownership: undefined,
    refine: new URLSearchParams({ workId: item.work.id }),
  }
}

function externalView(result: ExternalSearchResult): AddResultView {
  const target = externalTarget(result)
  const isWork = result.kind === 'WORK'
  // A work record carries no edition data — no ISBN, publisher or year of some printing. Its cover is the one
  // the card showed, and refining keeps it (BS-114).
  const edition = isWork
    ? { coverUrl: result.coverUrl }
    : {
        isbn: result.isbn13,
        lang: result.language,
        publisher: result.publisher,
        year: result.publishedYear,
        pageCount: result.pageCount,
        format: result.format,
        coverUrl: result.coverUrl,
      }

  return {
    title: result.title,
    authors: joined(result.authors),
    coverUrl: result.coverUrl,
    facts: [
      ...(isWork
        ? []
        : editionFacts({
            lang: result.language,
            publisher: result.publisher,
            year: result.publishedYear,
            isbn13: result.isbn13,
          })),
      ...firstPublished(result.firstPublishedYear),
    ],
    source: { kind: 'EXTERNAL', sources: result.sources },
    quickAdd: target === undefined ? undefined : { identities: externalIdentities(result), target },
    refineReason: target !== undefined ? undefined : isWork ? 'WORK' : 'NO_IDENTITY',
    editionUnknown: isWork && target !== undefined,
    ownership: undefined,
    refine: withRecord(
      manualPrefillParams({
        title: result.title,
        authors: result.authors,
        firstPubYear: result.firstPublishedYear,
        ...edition,
      }),
      result.id,
    ),
  }
}

function lookupView(isbn: string, lookup: BookLookupResult): AddResultView {
  return {
    title: lookup.title,
    authors: joined(lookup.authors),
    coverUrl: lookup.coverUrl,
    facts: editionFacts({
      lang: lookup.language,
      publisher: lookup.publisher,
      year: lookup.publishedYear,
      isbn13: isbn,
    }),
    source: { kind: 'LOOKUP', source: lookup.source },
    quickAdd: {
      identities: [isbnIdentity(isbn)],
      target: { kind: 'EXTERNAL_EDITION', isbn13: isbn },
    },
    refineReason: undefined,
    editionUnknown: false,
    ownership: undefined,
    refine: manualPrefillParams({
      title: lookup.title,
      authors: lookup.authors,
      isbn,
      lang: lookup.language,
      publisher: lookup.publisher,
      year: lookup.publishedYear,
      pageCount: lookup.pageCount,
      format: lookup.format,
      coverUrl: lookup.coverUrl,
    }),
  }
}

/** Everything the card and the dialog of one result show and offer, decided once. */
export function addResultView(subject: AddResultSubject): AddResultView {
  switch (subject.kind) {
    case 'EDITION':
      return editionView(subject.item)
    case 'WORK':
      return workView(subject.item)
    case 'EXTERNAL':
      return externalView(subject.result)
    case 'LOOKUP':
      return lookupView(subject.isbn, subject.lookup)
  }
}
