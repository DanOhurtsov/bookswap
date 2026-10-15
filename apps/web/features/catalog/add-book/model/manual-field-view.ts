import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import {
  TEXT_KIND_LABELS,
  type ManualFieldErrors,
  type ManualFieldName,
  type ManualFormValues,
} from './manual-form'

/** The two collapsible parts of the manual form: «Переклад (необов’язково)» and «Додатково». */
export type ManualSection = 'translation' | 'extra'

/** Every field in the order the form shows it — a failed «Додати до бібліотеки» focuses the first invalid one. */
const MANUAL_FIELD_ORDER: readonly ManualFieldName[] = [
  'title',
  'authors',
  'lang',
  'textKind',
  'translator',
  'translationLang',
  'translationSourceLang',
  'isbn',
  'publisher',
  'year',
  'pageCount',
  'format',
  'coverUrl',
  'firstPubYear',
]

const SECTION_OF: Partial<Readonly<Record<ManualFieldName, ManualSection>>> = {
  translator: 'translation',
  translationLang: 'translation',
  translationSourceLang: 'translation',
  publisher: 'extra',
  year: 'extra',
  pageCount: 'extra',
  format: 'extra',
  coverUrl: 'extra',
  firstPubYear: 'extra',
}

/**
 * How each field of the draft reads as text (BS-76): `null` — nothing is known, the field offers «Додати».
 * Codes are shown by name — languages, binding, «Це переклад?» — and an unanswered «Це переклад?» reads
 * «Не знаю», because UNKNOWN is a real answer, not an empty field.
 */
export type ManualFieldDisplay = {
  readonly [K in Exclude<ManualFieldName, 'authors'>]: string | null
} & { readonly authors: readonly string[] }

function text(value: string): string | null {
  const clean = value.trim()

  return clean === '' ? null : clean
}

function language(code: string): string | null {
  const clean = code.trim()

  return clean === '' ? null : languageName(clean)
}

export function manualFieldDisplay(values: ManualFormValues): ManualFieldDisplay {
  return {
    title: text(values.title),
    // Blank rows are not authors: `buildManualTarget` drops them too.
    authors: values.authors.map((name) => name.trim()).filter((name) => name !== ''),
    firstPubYear: text(values.firstPubYear),
    textKind: TEXT_KIND_LABELS[values.textKind],
    lang: language(values.lang),
    isbn: text(values.isbn),
    publisher: text(values.publisher),
    year: text(values.year),
    pageCount: text(values.pageCount),
    format: values.format === '' ? null : EDITION_FORMAT_LABELS[values.format],
    coverUrl: text(values.coverUrl),
    translator: text(values.translator),
    translationLang: language(values.translationLang),
    translationSourceLang: language(values.translationSourceLang),
  }
}

/**
 * What a failed «Додати до бібліотеки» must open so that no error hides behind a field's text or a
 * collapsed section: the invalid fields in form order (the first one gets focus) and their sections.
 * A form-level error (`form`) belongs to no field and opens nothing.
 */
export function manualRevealOf(errors: ManualFieldErrors): {
  fields: ManualFieldName[]
  sections: ManualSection[]
} {
  const fields = MANUAL_FIELD_ORDER.filter((name) => errors[name] !== undefined)
  const sections = new Set(fields.flatMap((name) => SECTION_OF[name] ?? []))

  return { fields, sections: [...sections] }
}
