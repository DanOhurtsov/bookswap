import {
  isbn13Schema,
  normalizeIsbn13,
  quickAddManualTargetSchema,
  type EditionFormat,
  type EditionTextKind,
  type QuickAddManualTarget,
} from '@bookswap/shared'

/**
 * Значення єдиної форми ручного додавання (docs/plan/fast-book-add.md, §2.4). Усе — рядки, як у полях вводу;
 * перетворення на контракт і перевірка — в `buildManualTarget`.
 */
export interface ManualFormValues {
  title: string
  authors: string[]
  firstPubYear: string
  /** «Це переклад?»: «Не знаю» — UNKNOWN, «Ні» — ORIGINAL, «Так» — TRANSLATION. */
  textKind: EditionTextKind
  /** Мова ВИДАННЯ (код ISO 639-1); порожнє — невідома. */
  lang: string
  isbn: string
  publisher: string
  year: string
  pageCount: string
  format: '' | EditionFormat
  coverUrl: string
  translator: string
  translationLang: string
  translationSourceLang: string
}

export type ManualFieldKey = keyof ManualFormValues | 'form'

export type ManualFieldErrors = Partial<Record<ManualFieldKey, string>>

export const EMPTY_MANUAL_FORM: ManualFormValues = {
  title: '',
  authors: [''],
  firstPubYear: '',
  textKind: 'UNKNOWN',
  lang: '',
  isbn: '',
  publisher: '',
  year: '',
  pageCount: '',
  format: '',
  coverUrl: '',
  translator: '',
  translationLang: '',
  translationSourceLang: '',
}

const trimmed = (value: string): string | undefined => {
  const text = value.trim()

  return text === '' ? undefined : text
}

function whole(
  value: string,
  field: ManualFieldKey,
  errors: ManualFieldErrors,
): number | undefined {
  const text = value.trim()

  if (text === '') return undefined

  const parsed = Number(text)

  if (!Number.isInteger(parsed)) {
    errors[field] = 'Потрібне ціле число'

    return undefined
  }

  return parsed
}

/** Куди в формі показати помилку контракту за шляхом поля. */
function fieldOf(path: readonly PropertyKey[]): ManualFieldKey {
  const [section, name] = path

  if (section === 'work') {
    if (name === 'title' || name === 'firstPubYear') return name

    return name === 'authors' ? 'authors' : 'form'
  }

  if (section === 'edition') {
    if (name === 'isbn13') return 'isbn'
    if (name === 'lang') return 'lang'
    if (
      name === 'publisher' ||
      name === 'year' ||
      name === 'pageCount' ||
      name === 'format' ||
      name === 'coverUrl'
    ) {
      return name
    }

    return 'form'
  }

  if (section === 'translation') {
    if (name === 'translator') return 'translator'
    if (name === 'lang') return 'translationLang'
    if (name === 'sourceLang') return 'translationSourceLang'
  }

  return 'form'
}

/**
 * Значення форми → ручна ціль додавання.
 *
 * Невідоме лишається невідомим: порожні поля просто не потрапляють у запит. Розділ перекладу необов'язковий:
 * порожній нічого не створює, а відкритий і заповнений проходить чинну перевірку своїх полів. Остаточне слово за
 * спільною схемою контракту — тією самою, що й на сервері.
 */
export function buildManualTarget(
  values: ManualFormValues,
  presetWorkId?: string,
): { ok: true; target: QuickAddManualTarget } | { ok: false; errors: ManualFieldErrors } {
  const errors: ManualFieldErrors = {}
  const isbn = trimmed(values.isbn)
  let isbn13: string | undefined

  if (isbn !== undefined) {
    const normalized = normalizeIsbn13(isbn)

    if (isbn13Schema.safeParse(normalized).success) isbn13 = normalized
    else errors.isbn = 'Некоректний ISBN-13: перевірте цифри (контрольна сума не сходиться)'
  }

  const year = whole(values.year, 'year', errors)
  const pageCount = whole(values.pageCount, 'pageCount', errors)
  const firstPubYear = whole(values.firstPubYear, 'firstPubYear', errors)
  const title = trimmed(values.title)
  const authors = values.authors.flatMap((name) => {
    const clean = trimmed(name)

    return clean === undefined ? [] : [{ name: clean }]
  })
  const translationFilled =
    values.textKind === 'TRANSLATION' &&
    [values.translator, values.translationLang, values.translationSourceLang].some(
      (field) => field.trim() !== '',
    )

  if (presetWorkId === undefined && title === undefined) errors.title = 'Вкажіть назву'

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const candidate = {
    kind: 'MANUAL',
    work:
      presetWorkId === undefined
        ? {
            title: title ?? '',
            ...(firstPubYear === undefined ? {} : { firstPubYear }),
            ...(authors.length === 0 ? {} : { authors }),
          }
        : { workId: presetWorkId },
    edition: {
      textKind: values.textKind,
      ...(trimmed(values.lang) === undefined ? {} : { lang: values.lang.trim() }),
      ...(isbn13 === undefined ? {} : { isbn13 }),
      ...(trimmed(values.publisher) === undefined ? {} : { publisher: values.publisher.trim() }),
      ...(year === undefined ? {} : { year }),
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(values.format === '' ? {} : { format: values.format }),
      ...(trimmed(values.coverUrl) === undefined ? {} : { coverUrl: values.coverUrl.trim() }),
    },
    ...(translationFilled
      ? {
          translation: {
            translator: values.translator.trim(),
            // Мова перекладу за замовчуванням — мова видання, яку людина вже назвала.
            lang: values.translationLang.trim() || values.lang.trim(),
            sourceLang: values.translationSourceLang.trim(),
          },
        }
      : {}),
  }
  const parsed = quickAddManualTargetSchema.safeParse(candidate)

  if (parsed.success) return { ok: true, target: parsed.data }

  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path)

    errors[field] ??= issue.message
  }

  return { ok: false, errors }
}

/** Початкові значення форми з адреси: назва, ISBN, автори, рік — те, що вже відомо з пошуку чи запису. */
export function manualInitialFrom(parameters: URLSearchParams): ManualFormValues {
  const authors = parameters.getAll('author').filter((name) => name.trim() !== '')

  return {
    ...EMPTY_MANUAL_FORM,
    title: parameters.get('title') ?? '',
    isbn: parameters.get('isbn') ?? '',
    firstPubYear: parameters.get('firstPubYear') ?? '',
    authors: authors.length === 0 ? [''] : authors,
  }
}
