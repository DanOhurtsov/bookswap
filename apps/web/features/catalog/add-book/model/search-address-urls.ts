import type { SearchPageSize } from '@bookswap/shared'
import { searchHref } from '@/app/lib/search-page'
import { AUTO_PARAM } from './auto-search'

export const ADD_BOOK_PATH = '/catalog/new'

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
 * Link to the manual form, prefilled from what is being searched. An ISBN wins over a title;
 * suggestions carry the normalized text, a full search the executed one; with nothing searched the
 * form opens empty.
 */
export function manualHref(input: {
  isbn: string | undefined
  autoActive: boolean
  enabled: boolean
  urlQuery: string
  query: string
}): string {
  const parameters = new URLSearchParams({ mode: 'manual' })

  if (input.isbn !== undefined) parameters.set('isbn', input.isbn)
  else if (input.autoActive) parameters.set('title', input.urlQuery)
  else if (input.enabled) parameters.set('title', input.query)

  return `${ADD_BOOK_PATH}?${parameters.toString()}`
}
