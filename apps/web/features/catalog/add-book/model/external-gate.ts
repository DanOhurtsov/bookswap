import { CATALOG_LIMITS, isValidIsbn13, type AddSearchExternalItem } from '@bookswap/shared'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { AUTO_EXTERNAL_MIN_CHARS } from './auto-search'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchReady,
  type ExternalHalfResponse,
  type ExternalSearchState,
} from './external-search-state'

/**
 * May the external half of the executed query be asked now (BS-134)?
 *
 * - `NONE` — never for this query: shorter than a search, or an ISBN (the exact path answers it);
 * - `OPEN` — yes: the query was released — by an explicit search, by an address from outside
 *   (opened, reloaded, Back/Forward, the scanner) or by typing after its own pause;
 * - `WAITING` — typed text whose pause (`AUTO_EXTERNAL_DELAY_MS`) has not passed yet: "not yet",
 *   never "nothing";
 * - `HELD` — typed text shorter than `AUTO_EXTERNAL_MIN_CHARS`: typing never asks the sources for
 *   it, only an explicit search does.
 */
export type ExternalGate = 'NONE' | 'OPEN' | 'WAITING' | 'HELD'

export function externalGateOf(input: {
  /** The executed query, trimmed, as the requests send it. */
  query: string
  /** The same query normalized — what typing compares and releases. */
  normalized: string
  released: string | undefined
}): ExternalGate {
  const { query, normalized, released } = input

  if (query.length < CATALOG_LIMITS.queryMin || isValidIsbn13(query)) return 'NONE'
  if (released === normalized) return 'OPEN'

  return normalized.length < AUTO_EXTERNAL_MIN_CHARS ? 'HELD' : 'WAITING'
}

/** The slice of a query result this needs (TanStack's `useQuery`). */
export type ExternalAnswer =
  | { status: 'pending' }
  | {
      status: 'error'
      error: unknown
      /** What the query held before the failed ask: TanStack keeps it on an error. */
      data?: ExternalHalfResponse<AddSearchExternalItem>
    }
  | { status: 'success'; data: ExternalHalfResponse<AddSearchExternalItem> }

/**
 * The external half's state for the list: gated first, then the answer. While the request is in
 * flight with a partial page painted (`complete: false`), the state is that partial page.
 *
 * A failed ask of a page already on hand — the visit that re-asks a page a source failed for, a
 * continuation stopped by 429 — keeps the rows it had and their promise: a failure hides nothing
 * already found. That page is shown as it stands (`complete`): nothing more is on its way, and the
 * next visit asks again. With no rows to keep it is the failure, never "nothing found".
 */
export function externalHalfOf(
  gate: ExternalGate,
  answer: ExternalAnswer,
): ExternalSearchState<AddSearchExternalItem> {
  if (gate === 'NONE' || gate === 'HELD') return IDLE_EXTERNAL_SEARCH
  if (gate === 'WAITING' || answer.status === 'pending') return { status: 'loading' }
  if (answer.status === 'error') {
    if (answer.data !== undefined && answer.data.results.length > 0) {
      return externalSearchReady({ ...answer.data, complete: true })
    }

    return { status: 'failed', message: describeAddBookError(answer.error) }
  }

  return externalSearchReady(answer.data)
}
