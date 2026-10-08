import type { SearchPageSize } from '@bookswap/shared'
import { readSearchAddress, searchHref } from '@/app/lib/search-page'
import { AUTO_PARAM } from './auto-search'

export const ADD_BOOK_PATH = '/catalog/new'

/** What the search shows: carried to the manual form as is, so "← До пошуку" restores it. */
const SEARCH_CONTEXT_KEYS = ['q', 'page', 'pageSize', AUTO_PARAM] as const

/** The manual form's own parameters: its mode and prefill. Never part of the way back. */
const MANUAL_FORM_KEYS = ['mode', 'workId', 'title', 'isbn', 'author', 'firstPubYear'] as const

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
