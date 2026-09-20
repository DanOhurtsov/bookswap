import {
  libraryImportInvalidCsvDetailsSchema,
  libraryImportInvalidXlsxDetailsSchema,
  libraryImportNotReadyDetailsSchema,
  libraryImportTooLargeDetailsSchema,
  type LibraryImportDraftResponse,
  type LibraryImportNotReadyReason,
  type LibraryImportRowResponse,
  type LibraryImportRowStatus,
} from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { describeInvalidCsv, describeInvalidXlsx, describeNotReadyReason } from './import-labels'

/**
 * R12: ONE canonical query for the whole draft. Summary, counts, readiness and
 * rows arrive in a single document and are cached under a single key, so the
 * row table and the readiness banner can never disagree — there is no second
 * source for them to disagree with.
 */
export function libraryImportQueryKey(importId: string): readonly [string, string] {
  return ['library-import', importId]
}

/**
 * The distinct ways reading or changing a draft can fail, each of which the UI
 * owes a different answer. Collapsing them into one "щось пішло не так" would
 * hide the only two that a person can actually act on: an expired draft (send
 * the file again) and a conflict (re-read, then decide again).
 */
export type ImportFailure =
  | { kind: 'not-found' }
  | { kind: 'expired' }
  | { kind: 'committed' }
  | { kind: 'conflict' }
  /**
   * 8g: the draft cannot be imported as it stands. Distinct from `conflict`
   * because the answer is different: a conflict means "look again", this means
   * "these rows still need you" — and the rows are named.
   */
  | {
      kind: 'not-ready'
      message: string
      /**
       * Kept structured, not only rendered: which recovery a row is offered
       * depends on WHY the commit was refused, and a sentence cannot be
       * branched on. `undefined` only when the body did not match the contract.
       */
      reason: LibraryImportNotReadyReason | undefined
      rowNumbers: number[]
    }
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; message: string }
  | { kind: 'file'; message: string }
  | { kind: 'other'; message: string }

export function classifyImportFailure(error: unknown): ImportFailure {
  if (!(error instanceof ApiRequestError)) return { kind: 'other', message: describeError(error) }

  if (error.status === 404) return { kind: 'not-found' }
  if (error.code === 'IMPORT_EXPIRED') return { kind: 'expired' }
  if (error.code === 'IMPORT_ROW_CONFLICT') return { kind: 'conflict' }
  if (error.code === 'IMPORT_NOT_READY') return describeNotReady(error)
  if (error.code === 'UNAUTHORIZED') return { kind: 'unauthorized' }
  if (error.code === 'TOO_MANY_REQUESTS') return { kind: 'rate-limited', message: error.message }
  if (error.code === 'CONFLICT') return { kind: 'committed' }

  const fileMessage = describeFileError(error)

  if (fileMessage !== undefined) return { kind: 'file', message: fileMessage }

  return { kind: 'other', message: error.message }
}

/**
 * 8g: `IMPORT_NOT_READY` carries a typed reason and the rows it is about.
 *
 * Parsed with the shared schema rather than trusted: a body that does not match
 * the contract falls back to the server's own sentence instead of rendering
 * `undefined` row numbers at somebody.
 */
function describeNotReady(error: ApiRequestError): ImportFailure {
  const details = libraryImportNotReadyDetailsSchema.safeParse(error.details)

  if (!details.success) {
    return { kind: 'not-ready', message: error.message, reason: undefined, rowNumbers: [] }
  }

  const rowNumbers = 'rowNumbers' in details.data ? details.data.rowNumbers : []

  return {
    kind: 'not-ready',
    message: describeNotReadyReason(details.data),
    reason: details.data.reason,
    rowNumbers: [...rowNumbers],
  }
}

/**
 * 8g: reasons whose fix is re-running the row's resolution.
 *
 * Both describe a catalog that moved after the preview: the edition now exists,
 * or the chosen work was merged away. The row itself still looks `READY_*` and
 * carries no `LOOKUP_UNAVAILABLE`, so nothing on it would otherwise offer a way
 * forward — which is exactly how a person ends up pressing "Імпортувати"
 * repeatedly against an error that will never clear on its own.
 *
 * `RETRY` stays an explicit act: this only says which rows may be retried, it
 * never runs one.
 */
const RETRYABLE_NOT_READY_REASONS: ReadonlySet<LibraryImportNotReadyReason> = new Set([
  'EDITION_APPEARED',
  'WORK_MERGED',
])

/** Rows the last commit failure says can be moved forward by re-resolving them. */
export function rowsAwaitingRetry(failure: ImportFailure | undefined): ReadonlySet<number> {
  if (failure?.kind !== 'not-ready') return EMPTY_ROWS
  if (failure.reason === undefined || !RETRYABLE_NOT_READY_REASONS.has(failure.reason)) {
    return EMPTY_ROWS
  }

  return new Set(failure.rowNumbers)
}

const EMPTY_ROWS: ReadonlySet<number> = new Set()

/**
 * `IMPORT_INVALID_CSV` / `IMPORT_TOO_LARGE` carry structured `details` (R6a).
 * They are parsed with the shared schemas rather than trusted: a body that does
 * not match the contract falls back to the server's own message instead of
 * rendering `undefined` into a sentence.
 */
function describeFileError(error: ApiRequestError): string | undefined {
  if (error.code === 'IMPORT_INVALID_CSV') {
    const details = libraryImportInvalidCsvDetailsSchema.safeParse(error.details)

    return details.success ? describeInvalidCsv(details.data) : error.message
  }

  if (error.code === 'IMPORT_INVALID_XLSX') {
    const details = libraryImportInvalidXlsxDetailsSchema.safeParse(error.details)

    return details.success ? describeInvalidXlsx(details.data) : error.message
  }

  if (error.code !== 'IMPORT_TOO_LARGE') return undefined

  const details = libraryImportTooLargeDetailsSchema.safeParse(error.details)

  if (!details.success) return error.message

  if (details.data.limit === 'ROWS') {
    return `У файлі забагато рядків: ${String(details.data.actual)} замість дозволених ${String(details.data.max)}.`
  }

  if (details.data.limit === 'COPIES') {
    return `У файлі забагато примірників: ${String(details.data.actual)} замість дозволених ${String(details.data.max)}.`
  }

  // The XLSX-only caps (8f-4). Each one names a different thing that was too
  // big, because "the file is too large" would be untrue for most of them —
  // the container is usually small and what it expands to is not.
  if (details.data.limit === 'UNCOMPRESSED_BYTES') {
    return `Розпакований вміст книги завеликий: максимум ${formatKib(details.data.max)}.`
  }

  if (details.data.limit === 'ZIP_ENTRIES' || details.data.limit === 'COMPRESSION_RATIO') {
    return 'Структура файла незвична для звичайної книги Excel. Відкрийте її в Excel і збережіть заново як .xlsx.'
  }

  if (details.data.limit === 'SHEETS') {
    return `У книзі забагато аркушів: ${String(details.data.actual)} замість дозволених ${String(details.data.max)}.`
  }

  // Phrased as "more than", because the count stops the moment the cap is
  // passed rather than walking the rest of the sheet to reach an exact total.
  if (details.data.limit === 'CELLS') {
    return `На аркуші понад ${String(details.data.max)} заповнених клітинок — більше, ніж можна імпортувати.`
  }

  if (details.data.limit === 'SHEET_ROWS') {
    return `На аркуші понад ${String(details.data.max)} рядків розмітки. Залиште аркуш лише з книжками, без порожніх рядків нижче.`
  }

  return `Файл завеликий: максимум ${formatKib(details.data.max)}.`
}

export function formatKib(bytes: number): string {
  return `${String(Math.round(bytes / 1024))} КіБ`
}

// --- Derived views over the one cached document -------------------------------

export const IMPORT_ROW_FILTERS = ['all', 'attention', 'ready', 'skipped'] as const

export type ImportRowFilter = (typeof IMPORT_ROW_FILTERS)[number]

export const IMPORT_ROW_FILTER_LABELS: Readonly<Record<ImportRowFilter, string>> = {
  all: 'Усі',
  attention: 'Потребують уваги',
  ready: 'Готові',
  skipped: 'Пропущені',
}

const FILTER_STATUSES: Readonly<Record<ImportRowFilter, readonly LibraryImportRowStatus[]>> = {
  all: ['READY_EXISTING_EDITION', 'READY_CREATE_CHAIN', 'NEEDS_REVIEW', 'INVALID', 'SKIPPED'],
  attention: ['NEEDS_REVIEW', 'INVALID'],
  ready: ['READY_EXISTING_EDITION', 'READY_CREATE_CHAIN'],
  skipped: ['SKIPPED'],
}

/**
 * The filtered table is a *view* of the cached draft, not a query of its own
 * (R12): no second key, no second request, and nothing to fall out of sync with
 * the counts rendered beside it.
 */
export function selectImportRows(
  draft: LibraryImportDraftResponse,
  filter: ImportRowFilter,
): LibraryImportRowResponse[] {
  const statuses = FILTER_STATUSES[filter]

  return draft.rows.filter((row) => statuses.includes(row.status))
}

export function countImportRows(
  draft: LibraryImportDraftResponse,
  filter: ImportRowFilter,
): number {
  const { counts } = draft

  switch (filter) {
    // Every tab counts from the server's own tally, `all` included — a local
    // `rows.length` would be a second, quietly diverging source for the same
    // number the other tabs take from `counts`.
    case 'all':
      return (
        counts.readyExistingEdition +
        counts.readyCreateChain +
        counts.needsReview +
        counts.invalid +
        counts.skipped
      )
    case 'attention':
      return counts.needsReview + counts.invalid
    case 'ready':
      return counts.readyExistingEdition + counts.readyCreateChain
    case 'skipped':
      return counts.skipped
  }
}
