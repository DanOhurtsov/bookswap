import { userSearchQuerySchema, type UserSearchResult } from '@bookswap/shared'
import { validate, type FieldErrors } from '@/app/lib/validation'

/** Pause after the last keystroke before the typed text is searched on its own. */
export const USER_SEARCH_DELAY_MS = 300

/**
 * How long an answer for one query counts as fresh: the header and the page — or Back to an
 * earlier query — reuse it without asking again. Friend actions invalidate it explicitly.
 */
export const USER_SEARCH_STALE_MS = 30_000

/** The header panel is a preview: the full answer (`USER_SEARCH_LIMIT`) lives on the page. */
export const HEADER_RESULTS_LIMIT = 5

export const USER_SEARCH_PATH = '/friends/search'

/** The address parameter: the same name the API takes. */
export const USER_SEARCH_QUERY_PARAM = 'query'

/** `/friends/search?query=…`, encoded by `URLSearchParams`; no query — the bare page. */
export function userSearchPageHref(query: string | undefined): string {
  if (query === undefined || isBlankSearch(query)) return USER_SEARCH_PATH

  return `${USER_SEARCH_PATH}?${new URLSearchParams({ [USER_SEARCH_QUERY_PARAM]: query }).toString()}`
}

export function isBlankSearch(text: string): boolean {
  return text.trim() === ''
}

/**
 * The rules the API applies to `?query=`: at least two characters after trimming. Whether the
 * value is also an exact email address is decided by the server, not here.
 */
export function validateSearch(
  text: string,
): { ok: true; query: string } | { ok: false; errors: FieldErrors } {
  const result = validate(userSearchQuerySchema, text)

  return result.ok ? { ok: true, query: result.data } : result
}

/**
 * What the results panel shows.
 *
 * - `waiting` — the text is searchable, the pause before the request has not run out yet;
 * - `loading` — the request for exactly this text is in flight (a manual run would duplicate it).
 */
export type UserSearchView =
  | { status: 'idle' }
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; results: UserSearchResult[] }

export interface UserSearchViewInput {
  /** The search for the current text; `undefined` until it is due, or when there is none. */
  active: string | undefined
  /** Searchable text whose request is not due yet. */
  pending: boolean
  /** The query for `active` — never for an earlier text, so nothing here can be stale. */
  query: { data: UserSearchResult[] | undefined; error: unknown; isFetching: boolean }
}

export function userSearchView({ active, pending, query }: UserSearchViewInput): UserSearchView {
  if (active === undefined) return pending ? { status: 'waiting' } : { status: 'idle' }

  // A refetch after a friend action hides the old relations until the new ones arrive.
  if (query.isFetching) return { status: 'loading' }
  if (query.error !== null && query.error !== undefined) {
    return { status: 'failed', error: query.error }
  }
  if (query.data !== undefined) return { status: 'ready', results: query.data }

  return { status: 'loading' }
}
