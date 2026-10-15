import type { SearchPageSize } from '@bookswap/shared'
import { readSearchAddress, searchHref } from '@/app/lib/search-page'
import { AUTO_PARAM } from './auto-search'
import { MANUAL_PREFILL_KEYS } from './manual-form'

export const ADD_BOOK_PATH = '/catalog/new'

/** What the search shows: carried to the manual form as is, so "← До пошуку" restores it. */
const SEARCH_CONTEXT_KEYS = ['q', 'page', 'pageSize', AUTO_PARAM] as const

/**
 * The external record a manual form was opened from (`<SOURCE>:<id>`): only part of the form's identity —
 * two records may share every prefilled value, title included, and still be different books.
 */
export const RECORD_PARAM = 'record'

/** The forms' own parameters: mode, what they were opened for and the prefill. Never part of the way back. */
const MANUAL_FORM_KEYS = [
  'mode',
  'workId',
  'editionId',
  RECORD_PARAM,
  ...MANUAL_PREFILL_KEYS,
] as const

/** The form's own parameters in a fixed order, the mode left out: what this manual form was opened for. */
function manualFormOf(parameters: URLSearchParams): string {
  const own = new URLSearchParams()

  for (const key of MANUAL_FORM_KEYS) {
    if (key === 'mode') continue

    for (const value of parameters.getAll(key)) own.append(key, value)
  }

  return own.toString()
}

/**
 * Which screen the address shows. `editionId` with its `workId` — «Уточнити дані» of an edition that is
 * already in the catalog (BS-114); `workId` alone — a new edition of an existing work; `mode=manual` —
 * the manual form.
 */
export type AddBookMode =
  | { kind: 'search' }
  | {
      kind: 'manual'
      presetWorkId: string | null
      /** What the form was opened for — `manualFormOf`; the search context is not part of it. */
      form: string
    }
  | { kind: 'edition'; editionId: string; workId: string }

export function addBookModeOf(parameters: URLSearchParams): AddBookMode {
  const workId = parameters.get('workId')
  const editionId = parameters.get('editionId')

  if (editionId !== null && workId !== null) return { kind: 'edition', editionId, workId }
  if (parameters.get('mode') === 'manual' || workId !== null) {
    return { kind: 'manual', presetWorkId: workId, form: manualFormOf(parameters) }
  }

  return { kind: 'search' }
}

/**
 * One manual form's intent — its add slot and its screen key at once, so the slot, the form's draft and
 * «open the library after success» can never disagree. Different forms (another record, another prefill)
 * are different intents; coming back to the same form finds its operation again, an unresolved one
 * included. `manualKey` turns the page after «Додати ще одну книжку» into a new intent.
 */
export function manualIntentOf(form: string, manualKey: number): string {
  return `manual:${String(manualKey)}:${form}`
}

/**
 * The key of the screen an add was started from (`QuickAddAttempt.screen`). The search has none: a
 * success in its dialog stays there. A form's key names its own intent — the manual form's add slot
 * or the refined edition.
 */
export function screenKeyOf(mode: AddBookMode, manualKey: number): string | undefined {
  if (mode.kind === 'search') return undefined

  return mode.kind === 'edition'
    ? `edition:${mode.editionId}`
    : manualIntentOf(mode.form, manualKey)
}

/**
 * After a confirmed add, the library opens only for a form's own operation, and only while that very
 * form is still on screen: a late answer after the person moved on does not carry them away (BS-114).
 */
export function opensLibraryAfterAdd(
  startedOn: string | undefined,
  current: string | undefined,
): boolean {
  return startedOn !== undefined && startedOn === current
}

/** Key for "what the address is right now": mode and query. An address we just wrote ourselves does not reset the field. */
export function addressKey(auto: boolean, query: string): string {
  return `${auto ? 'auto' : 'full'}\u0000${query}`
}

/**
 * Address of auto-suggestions: `auto=1` and the first page. A separate address mode, not an executed
 * full search — hence `replace`, not `push`: suggestions do not clutter history.
 */
export function autoHref(
  parameters: URLSearchParams,
  query: string,
  pageSize: SearchPageSize,
): string {
  return `${searchHref(ADD_BOOK_PATH, parameters, { q: query, page: 1, pageSize }, [AUTO_PARAM])}&${AUTO_PARAM}=1`
}

/** Address without a query: the field was emptied, suggestions disappear. */
export function clearedHref(parameters: URLSearchParams): string {
  const next = new URLSearchParams(parameters)

  for (const key of ['q', 'page', 'pageSize', AUTO_PARAM]) next.delete(key)

  const rest = next.toString()

  return rest === '' ? ADD_BOOK_PATH : `${ADD_BOOK_PATH}?${rest}`
}

/**
 * Any link to the manual form: `mode=manual`, the prefill, then the search context of `current`.
 * The query and the prefill are separate parameters (`q` vs `title`/`isbn`), so editing the form
 * never changes the search the way back returns to.
 */
export function manualFormHref(prefill: URLSearchParams, current: URLSearchParams): string {
  const parameters = new URLSearchParams({ mode: 'manual' })

  for (const [key, value] of prefill) parameters.append(key, value)

  for (const key of SEARCH_CONTEXT_KEYS) {
    for (const value of current.getAll(key)) parameters.append(key, value)
  }

  return `${ADD_BOOK_PATH}?${parameters.toString()}`
}

/**
 * Link to the manual form, prefilled from what is being searched. An ISBN wins over a title;
 * suggestions carry the normalized text, a full search the executed one; with nothing searched the
 * form opens empty.
 */
export function manualHref(input: {
  parameters: URLSearchParams
  isbn: string | undefined
  autoActive: boolean
  enabled: boolean
  urlQuery: string
  query: string
}): string {
  const prefill = new URLSearchParams()

  if (input.isbn !== undefined) prefill.set('isbn', input.isbn)
  else if (input.autoActive) prefill.set('title', input.urlQuery)
  else if (input.enabled) prefill.set('title', input.query)

  return manualFormHref(prefill, input.parameters)
}

/**
 * "← До пошуку" from the manual form: the search the form was opened from — query, page, size and
 * the suggestions mode — without the form's own parameters. Opened directly, it is an empty search.
 */
export function backToSearchHref(parameters: URLSearchParams): string {
  const address = readSearchAddress(parameters)

  return searchHref(
    ADD_BOOK_PATH,
    parameters,
    { q: address.q, page: address.page, pageSize: address.pageSize },
    MANUAL_FORM_KEYS,
  )
}
