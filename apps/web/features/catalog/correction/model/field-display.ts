import type { EditionTextKind, Translation } from '@bookswap/shared'
import { AUTHOR_ROLE_LABELS, EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import type { AuthorFormValue } from './author-list'
import type { EditionCorrectionFormValues } from './edition-form'
import type { TranslationCorrectionFormValues } from './translation-form'
import type { WorkCorrectionFormValues } from './work-form'

/**
 * Text view of the correction forms' draft values. `null` always means "the
 * field is empty" — the view then offers «Додати» instead of a value. `false`
 * and `0` are values, never blanks: «ні» and «0» are facts someone entered.
 */
type Display = string | null

export const EDITION_TEXT_KIND_LABELS: Readonly<Record<EditionTextKind, string>> = {
  UNKNOWN: 'Невідомо: оригінал чи переклад',
  ORIGINAL: 'Оригінал',
  TRANSLATION: 'Переклад',
}

export interface AuthorName {
  name: string
  nameLatin: string | null
}

export interface AuthorDisplayRow {
  key: string
  name: string
  nameLatin: string | null
  role: string
}

function textDisplay(value: string | null): Display {
  return value === null || value.trim() === '' ? null : value
}

function numberDisplay(value: number | null): Display {
  return value === null ? null : String(value)
}

function languageDisplay(code: string | null): Display {
  return code === null || code === '' ? null : languageName(code)
}

function yesNo(value: boolean): string {
  return value ? 'так' : 'ні'
}

/** One label for a Translation, shared by the edition's select options and its text view. */
export function translationLabel(translation: Pick<Translation, 'translator' | 'lang'>): string {
  return `${translation.translator} (${languageName(translation.lang)})`
}

/**
 * Names come from `names` for an existing author (`authorId`) — the form value
 * itself carries only the id (strict PATCH shape, see `author-list.ts`) — and
 * from the value for a new one. Keys stay unique when the same author or the
 * same new name appears twice.
 */
export function authorDisplayRows(
  authors: readonly AuthorFormValue[],
  names: ReadonlyMap<string, AuthorName>,
): AuthorDisplayRow[] {
  const seen = new Map<string, number>()

  return authors.map((author) => {
    const known = author.authorId === undefined ? undefined : names.get(author.authorId)
    const identity = author.authorId ?? `new:${author.name ?? ''}`
    const occurrence = (seen.get(identity) ?? 0) + 1

    seen.set(identity, occurrence)

    return {
      key: `${identity}#${String(occurrence)}`,
      name: known?.name ?? author.name ?? '',
      nameLatin: known === undefined ? (author.nameLatin ?? null) : known.nameLatin,
      role: AUTHOR_ROLE_LABELS[author.role ?? 'AUTHOR'],
    }
  })
}

export function workFieldsDisplay(
  values: Pick<WorkCorrectionFormValues, 'title' | 'origLang' | 'firstPubYear' | 'description'>,
) {
  return {
    title: textDisplay(values.title),
    origLang: languageDisplay(values.origLang),
    firstPubYear: numberDisplay(values.firstPubYear),
    description: textDisplay(values.description),
  }
}

export function translationFieldsDisplay(
  values: Omit<TranslationCorrectionFormValues, 'expectedRevision'>,
) {
  return {
    translator: textDisplay(values.translator),
    lang: languageDisplay(values.lang),
    sourceLang: languageDisplay(values.sourceLang),
    year: numberDisplay(values.year),
    isAbridged: yesNo(values.isAbridged),
    hasNotes: yesNo(values.hasNotes),
    notes: textDisplay(values.notes),
  }
}

export function editionFieldsDisplay(
  values: Omit<EditionCorrectionFormValues, 'expectedRevision'>,
  translations: readonly Translation[],
) {
  const translation = translations.find((candidate) => candidate.id === values.translationId)

  return {
    translationId:
      values.translationId === null
        ? null
        : translation === undefined
          ? values.translationId
          : translationLabel(translation),
    textKind: EDITION_TEXT_KIND_LABELS[values.textKind],
    lang: languageDisplay(values.lang),
    publisher: textDisplay(values.publisher),
    year: numberDisplay(values.year),
    isbn13: textDisplay(values.isbn13),
    pageCount: numberDisplay(values.pageCount),
    coverUrl: textDisplay(values.coverUrl),
    format: values.format === '' ? null : EDITION_FORMAT_LABELS[values.format],
  }
}
