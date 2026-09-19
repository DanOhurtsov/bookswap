import type {
  LibraryImportCsvColumn,
  LibraryImportInvalidCsvDetails,
  LibraryImportLookupUnavailableReason,
  LibraryImportRowError,
  LibraryImportRowStatus,
} from '@bookswap/shared'

/**
 * Ukrainian wording for everything the import API returns as a code (§4: "Текст
 * локалізує web; API повертає code і structured details").
 *
 * Statuses are named as well as coloured — a person who cannot tell the colours
 * apart still has to be able to tell a skipped row from a broken one.
 */

export const IMPORT_ROW_STATUS_LABELS: Readonly<Record<LibraryImportRowStatus, string>> = {
  READY_EXISTING_EDITION: 'Готово — видання вже в каталозі',
  READY_CREATE_CHAIN: 'Готово — буде створено в каталозі',
  NEEDS_REVIEW: 'Потребує уваги',
  INVALID: 'Помилка в даних',
  SKIPPED: 'Пропущено',
}

/** Short badge text for the compact list, where the full sentence would not fit. */
export const IMPORT_ROW_STATUS_BADGES: Readonly<Record<LibraryImportRowStatus, string>> = {
  READY_EXISTING_EDITION: 'Готово',
  READY_CREATE_CHAIN: 'Готово',
  NEEDS_REVIEW: 'Потребує уваги',
  INVALID: 'Помилка',
  SKIPPED: 'Пропущено',
}

export const IMPORT_COLUMN_LABELS: Readonly<Record<LibraryImportCsvColumn, string>> = {
  isbn13: 'ISBN-13',
  title: 'Назва',
  authors: 'Автори (через |)',
  orig_lang: 'Мова оригіналу',
  first_pub_year: 'Рік першого видання',
  edition_lang: 'Мова видання',
  translator: 'Перекладач',
  translation_source_lang: 'Мова, з якої перекладено',
  translation_year: 'Рік перекладу',
  is_abridged: 'Скорочений переклад (true/false)',
  has_notes: 'Є примітки (true/false)',
  translation_notes: 'Примітки до перекладу',
  publisher: 'Видавництво',
  edition_year: 'Рік видання',
  page_count: 'Сторінок',
  cover_url: 'Обкладинка (посилання)',
  format: 'Палітурка',
  condition: 'Стан примірника',
  visibility: 'Кому показувати',
  note: 'Приватна нотатка',
  acquired_at: 'Коли зʼявилася (РРРР-ММ-ДД)',
  quantity: 'Кількість примірників',
}

const LOOKUP_UNAVAILABLE_REASONS: Readonly<Record<LibraryImportLookupUnavailableReason, string>> = {
  PROVIDER_ERROR: 'довідник відповів помилкою',
  TIMEOUT: 'довідник не відповів вчасно',
  BUDGET_EXHAUSTED: 'ліміт звернень до довідника на цей файл вичерпано',
  CONCURRENT_UPDATE: 'рядок змінився під час пошуку',
}

function columnList(columns: readonly LibraryImportCsvColumn[]): string {
  return columns.map((column) => IMPORT_COLUMN_LABELS[column]).join(', ')
}

/**
 * One row error → one sentence a person can act on.
 *
 * `MISSING_CATALOG_DATA` and `CONFLICTING_CATALOG_DATA` carry the same shape but
 * mean opposite things (R7a), so they must never share wording: one asks to fill
 * something in, the other asks to decide between values that are each valid.
 */
export function describeRowError(error: LibraryImportRowError): string {
  switch (error.code) {
    case 'INVALID_ISBN':
      return 'ISBN-13 некоректний: перевірте цифри й контрольну суму.'
    case 'INVALID_FIELD':
      return `Некоректне значення поля «${IMPORT_COLUMN_LABELS[error.field]}».`
    case 'DUPLICATE_ROW':
      return `Такий самий рядок уже є вище (рядок ${String(error.firstRowNumber)}). Щоб додати другий примірник, збільште кількість у тому рядку.`
    case 'LOOKUP_NOT_FOUND':
      return 'Жоден довідник не знає цього ISBN. Заповніть дані про книжку вручну.'
    case 'LOOKUP_UNAVAILABLE':
      return `Не вдалося звернутися до довідника: ${LOOKUP_UNAVAILABLE_REASONS[error.reason]}. Спробуйте ще раз.`
    case 'MISSING_CATALOG_DATA':
      return `Бракує даних, щоб створити книжку в каталозі. Заповніть: ${columnList(error.fields)}.`
    case 'CONFLICTING_CATALOG_DATA':
      return `Ці значення суперечать одне одному — потрібне ваше рішення: ${columnList(error.fields)}.`
    case 'AMBIGUOUS_CATALOG_MATCH':
      return 'У каталозі вже є схожі твори. Оберіть потрібний або створіть новий.'
  }
}

/** A file the server refused to parse at all — no rows, so no row errors either. */
export function describeInvalidCsv(details: LibraryImportInvalidCsvDetails): string {
  switch (details.reason) {
    case 'HEADER_MISMATCH':
      return 'Заголовок файла не збігається з шаблоном: колонки, їхній порядок і назви мають бути точно такими, як у шаблоні.'
    case 'AMBIGUOUS_DELIMITER':
      return 'Не вдалося визначити роздільник: у файлі змішані коми й крапки з комою.'
    case 'COLUMN_COUNT':
      return `У рядку ${String(details.line)} інша кількість колонок, ніж у заголовку.`
    case 'MALFORMED_CSV':
      return `Структура CSV зламана біля рядка ${String(details.line)} — найчастіше це незакриті лапки.`
    case 'INVALID_ENCODING':
      return 'Файл не у кодуванні UTF-8. Збережіть його як CSV UTF-8 і спробуйте ще раз.'
    case 'EMPTY':
      return 'У файлі лише заголовок, без жодної книжки.'
  }
}
