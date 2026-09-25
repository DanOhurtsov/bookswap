import type { Edition, ExternalSearchResult, Translation, Work, WorkAuthor } from '@bookswap/shared'

/**
 * What the list needs to know about a work already in BookSwap.
 *
 * Deliberately narrower than `WorkDetailResponse`, because two endpoints answer
 * with a local work and only one of them carries translations:
 * `/catalog/search` returns `CatalogSearchResult`, `/catalog/search/candidates`
 * returns `WorkDetailResponse`. Both satisfy this shape, so ONE list
 * implementation serves both screens.
 */
export interface LocalCandidate {
  work: Work
  authors: WorkAuthor[]
  editions: Edition[]
  /** Only the candidates endpoint carries these (the wizard needs them). */
  translations?: Translation[]
}

/**
 * One row of the single result list.
 *
 * Local and external entries stay distinct types rather than being flattened
 * into a common shape, because what a person may DO with them differs: a local
 * work offers its existing editions ("this is mine"), an external record leads
 * to a duplicate check and a prefilled form.
 */
export type UnifiedResult<TLocal extends LocalCandidate = LocalCandidate> =
  | { origin: 'LOCAL'; key: string; candidate: TLocal }
  | { origin: 'EXTERNAL'; key: string; result: ExternalSearchResult }

/**
 * Local rows and external rows as ONE list — in the order the SERVER paged them.
 *
 * **No re-sorting here.** The shared list is our own catalog's matches followed by
 * the external pool (`splitSearchPage`), and the page boundaries are cut on that
 * order. Sorting a page's rows on the client by any other key would show a set of
 * rows that no boundary computation produced — and would quietly make page 2
 * disagree with page 1 about what came first.
 *
 * **No deduplication here either.** An external record whose ISBN our catalog
 * already holds is dropped by the SERVER before the page is cut (so the page stays
 * full and the same book cannot come back on the next page). Nothing is left for
 * the client to filter, and filtering after paging is exactly what would leave
 * short pages.
 */
export function buildUnifiedResults<TLocal extends LocalCandidate>(
  candidates: readonly TLocal[],
  external: readonly ExternalSearchResult[],
): UnifiedResult<TLocal>[] {
  return [
    ...candidates.map((candidate): UnifiedResult<TLocal> => ({
      origin: 'LOCAL',
      key: `local:${candidate.work.id}`,
      candidate,
    })),
    ...external.map((result): UnifiedResult<TLocal> => ({
      origin: 'EXTERNAL',
      key: `external:${result.id}`,
      result,
    })),
  ]
}
