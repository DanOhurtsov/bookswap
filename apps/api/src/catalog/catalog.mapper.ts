import type {
  AuthorRole,
  Edition,
  EditionRevisionSnapshot,
  Translation,
  TranslationRevisionSnapshot,
  ViewerCapabilities,
  Work,
  WorkAuthor,
  WorkRevisionSnapshot,
} from '@bookswap/shared'
import type {
  AuthorModel,
  EditionModel,
  TranslationModel,
  WorkModel,
} from '../generated/prisma/models'

/**
 * Чисті проєкції Prisma → контракт. Без Nest і без Prisma-клієнта: усе, що тут
 * є, — перекладання полів, тож воно покривається unit-тестом без PostgreSQL.
 *
 * Типи вхідних даних структурні (`Pick<>`), а не моделі цілком: мапер має
 * залежати від полів, які читає, а не від таблиці. Якщо в схемі зникне поле,
 * зламається саме тут, а не десь у рантаймі.
 */

export type WorkRow = Pick<
  WorkModel,
  'id' | 'title' | 'origLang' | 'firstPubYear' | 'description' | 'createdAt' | 'revision'
>

export interface WorkAuthorRow {
  role: AuthorRole
  /** Stage 8e-1, R10a: manual order — the sole ordering key, see `toWorkAuthors`. */
  position: number
  author: Pick<AuthorModel, 'id' | 'name' | 'nameLatin'>
}

export type TranslationRow = Pick<
  TranslationModel,
  | 'id'
  | 'workId'
  | 'translator'
  | 'lang'
  | 'sourceLang'
  | 'year'
  | 'isAbridged'
  | 'hasNotes'
  | 'notes'
  | 'revision'
>

export type EditionRow = Pick<
  EditionModel,
  | 'id'
  | 'workId'
  | 'translationId'
  | 'publisher'
  | 'year'
  | 'isbn13'
  | 'pageCount'
  | 'coverUrl'
  | 'format'
  | 'textKind'
  | 'lang'
  | 'revision'
> & {
  translation: Pick<TranslationModel, 'lang' | 'translator'> | null
}

export function toWork(work: WorkRow): Work {
  return {
    id: work.id,
    title: work.title,
    origLang: work.origLang,
    firstPubYear: work.firstPubYear,
    description: work.description,
    createdAt: work.createdAt.toISOString(),
    revision: work.revision,
  }
}

/**
 * Stage 8e-1, R10a: `position` — єдине джерело порядку. Роль більше не задає
 * власне сортування (вона й раніше не була ідентичністю зв'язку, лише
 * первинним тай-брейком) — після backfill і create/merge, що призначають
 * `position` самі, читання його більше не пересортовує.
 */
export function toWorkAuthors(rows: WorkAuthorRow[]): WorkAuthor[] {
  return [...rows]
    .sort((one, other) => one.position - other.position)
    .map((row) => ({
      id: row.author.id,
      name: row.author.name,
      nameLatin: row.author.nameLatin,
      role: row.role,
      position: row.position,
    }))
}

export function toTranslation(translation: TranslationRow, editionCount: number): Translation {
  return {
    id: translation.id,
    workId: translation.workId,
    translator: translation.translator,
    lang: translation.lang,
    sourceLang: translation.sourceLang,
    year: translation.year,
    isAbridged: translation.isAbridged,
    hasNotes: translation.hasNotes,
    notes: translation.notes,
    editionCount,
    revision: translation.revision,
  }
}

/**
 * `textKind` і `lang` — що відомо про текст ЦЬОГО видання, а не висновок із відсутності перекладу
 * (docs/plan/fast-book-add.md, §4); `translator` береться лише з перекладу.
 *
 * Рахується один раз тут, а не на кожній сторінці, що показує видання: інакше правило
 * «якщо переклад є — беремо з нього» розповзеться по клієнту й одного дня розійдеться само з собою.
 */
export function toEdition(edition: EditionRow): Edition {
  return {
    id: edition.id,
    workId: edition.workId,
    translationId: edition.translationId,
    publisher: edition.publisher,
    year: edition.year,
    isbn13: edition.isbn13,
    pageCount: edition.pageCount,
    coverUrl: edition.coverUrl,
    format: edition.format,
    textKind: edition.textKind,
    lang: edition.lang,
    translator: edition.translation?.translator ?? null,
    revision: edition.revision,
  }
}

/**
 * Новіше — вище: людина шукає своє видання очима, і рік звужує вибір швидше за
 * будь-що інше. Видання без року йдуть у кінець, а не на початок: невідомий рік
 * не робить книжку найновішою.
 */
export function byEditionOrder(
  one: Pick<Edition, 'id' | 'year' | 'publisher'>,
  other: Pick<Edition, 'id' | 'year' | 'publisher'>,
): number {
  if (one.year !== other.year) {
    if (one.year === null) return 1
    if (other.year === null) return -1

    return other.year - one.year
  }

  return (
    (one.publisher ?? '').localeCompare(other.publisher ?? '', 'uk') ||
    one.id.localeCompare(other.id)
  )
}

export interface ViewerOwnedEditionRow {
  id: string
  createdById: string
  translationId: string | null
  /** Pre-filtered to `ownerId: <viewer>` at the query — see `CatalogService.getWork`. */
  copies: { id: string }[]
}

export interface ViewerTranslationRow {
  id: string
  createdById: string
}

/**
 * Stage 8e-2, R8/R10: what `userId` may `PATCH` on this Work, derived from a
 * single already-fetched row — no query of its own. `copies` on each edition
 * is pre-filtered to this viewer's ownership at the query that produced
 * `work`, so "owns a Copy" is just "the array isn't empty", not a second
 * lookup.
 */
export function toViewerCapabilities(
  userId: string,
  work: {
    createdById: string
    editions: ViewerOwnedEditionRow[]
    translations: ViewerTranslationRow[]
  },
): ViewerCapabilities {
  const ownedEditionIds = new Set(
    work.editions.filter((edition) => edition.copies.length > 0).map((edition) => edition.id),
  )

  const canEditWork = work.createdById === userId || ownedEditionIds.size > 0

  const editableEditionIds = work.editions
    .filter((edition) => edition.createdById === userId || ownedEditionIds.has(edition.id))
    .map((edition) => edition.id)

  // R8: a Translation is editable through ownership of a Copy of ANY Edition
  // that references it — not just one.
  const ownedTranslationIds = new Set(
    work.editions
      .filter((edition) => edition.translationId !== null && ownedEditionIds.has(edition.id))
      .map((edition) => edition.translationId as string),
  )

  const editableTranslationIds = work.translations
    .filter(
      (translation) =>
        translation.createdById === userId || ownedTranslationIds.has(translation.id),
    )
    .map((translation) => translation.id)

  return { canEditWork, editableTranslationIds, editableEditionIds }
}

/** Stage 8e-2, R9: full editable-metadata snapshot for `CatalogRevision.before`/`after`. */
export function toWorkRevisionSnapshot(work: {
  title: string
  origLang: string | null
  firstPubYear: number | null
  description: string | null
  authors: WorkAuthorRow[]
}): WorkRevisionSnapshot {
  return {
    title: work.title,
    origLang: work.origLang,
    firstPubYear: work.firstPubYear,
    description: work.description,
    authors: toWorkAuthors(work.authors).map((author) => ({
      authorId: author.id,
      name: author.name,
      nameLatin: author.nameLatin,
      role: author.role,
      position: author.position,
    })),
  }
}

export function toTranslationRevisionSnapshot(translation: {
  translator: string
  lang: string
  sourceLang: string
  year: number | null
  isAbridged: boolean
  hasNotes: boolean
  notes: string | null
}): TranslationRevisionSnapshot {
  return {
    translator: translation.translator,
    lang: translation.lang,
    sourceLang: translation.sourceLang,
    year: translation.year,
    isAbridged: translation.isAbridged,
    hasNotes: translation.hasNotes,
    notes: translation.notes,
  }
}

export function toEditionRevisionSnapshot(edition: {
  publisher: string | null
  year: number | null
  isbn13: string | null
  pageCount: number | null
  coverUrl: string | null
  format: EditionModel['format']
  translationId: string | null
  textKind: EditionModel['textKind']
  lang: string | null
}): EditionRevisionSnapshot {
  return {
    publisher: edition.publisher,
    year: edition.year,
    isbn13: edition.isbn13,
    pageCount: edition.pageCount,
    coverUrl: edition.coverUrl,
    format: edition.format,
    translationId: edition.translationId,
    // Знімок несе збережене, а не виведене: легасі-рядок (R2, до backfill) лишається `null`.
    textKind: edition.textKind,
    lang: edition.lang,
  }
}
