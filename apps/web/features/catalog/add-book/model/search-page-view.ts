import {
  externalSearchMore,
  externalSearchSettled,
  type ExternalSearchState,
} from './external-search-state'
import { nextPageOf, type NextPage } from '@/app/lib/search-page'

/**
 * What the shared list's controls need to know, from the two halves' states.
 *
 * One function for both routes: the answer to "is there a next page, and has the
 * search finished" must not be computed twice and drift apart.
 *
 * - `next` — the honest promise about a further page (`nextPageOf`): the local
 *   `hasMore` is only trusted from a READY answer, and the external `more` is
 *   `NO` until it is ready — "we have not looked" is never a next page.
 * - `finished` — both halves answered (the local one ready, the external one
 *   settled). "Nothing found" may only be said then.
 */
export function searchPageView(input: {
  page: number
  local: { ready: boolean; hasMore: boolean }
  rowCount: number
  external: ExternalSearchState
}): { next: NextPage; currentHasRows: boolean; finished: boolean } {
  return {
    next: nextPageOf({
      page: input.page,
      localHasMore: input.local.ready && input.local.hasMore,
      externalMore: externalSearchMore(input.external),
    }),
    currentHasRows: input.rowCount > 0,
    finished: input.local.ready && externalSearchSettled(input.external),
  }
}
