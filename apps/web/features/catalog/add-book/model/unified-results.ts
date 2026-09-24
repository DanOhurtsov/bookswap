import { relevanceOf } from '@bookswap/shared'
import type { Edition, ExternalSearchResult, Work, WorkAuthor } from '@bookswap/shared'

/**
 * What the list needs to know about a work already in BookSwap.
 *
 * Deliberately narrower than `WorkDetailResponse`, because two endpoints answer
 * with a local work and only one of them carries translations:
 * `/catalog/search` (the catalog page) returns `CatalogSearchResult`,
 * `/catalog/search/candidates` (the wizard) returns `WorkDetailResponse`. Both
 * satisfy this shape, so ONE list implementation serves both screens — the
 * alternative was a second copy of the ordering and deduplication rules, which
 * is exactly how the two screens would drift apart.
 */
export interface LocalCandidate {
  work: Work
  authors: WorkAuthor[]
  editions: Edition[]
}

/**
 * One row of the single result list.
 *
 * Local and external entries stay distinct types rather than being flattened
 * into a common shape, because what a person may DO with them differs: a local
 * work offers its existing editions ("this is mine"), an external record leads
 * to a duplicate check and a prefilled form. Flattening would have to erase
 * exactly the part that decides the next step.
 */
export type UnifiedResult<TLocal extends LocalCandidate = LocalCandidate> =
  | { origin: 'LOCAL'; key: string; score: number; candidate: TLocal }
  | { origin: 'EXTERNAL'; key: string; score: number; result: ExternalSearchResult }

/** Every ISBN-13 our catalog already has among the shown candidates. */
function localIsbns(candidates: readonly LocalCandidate[]): Set<string> {
  const isbns = new Set<string>()

  for (const candidate of candidates) {
    for (const edition of candidate.editions) {
      if (edition.isbn13 !== null) isbns.add(edition.isbn13)
    }
  }

  return isbns
}

function localScore(query: string, candidate: LocalCandidate): number {
  return relevanceOf(query, {
    title: candidate.work.title,
    authors: candidate.authors.map((author) => author.name),
  }).score
}

/**
 * Local candidates and external candidates as ONE ordered list.
 *
 * **Ordering.** By `relevanceOf` against the query, computed the same way for
 * both halves — that shared score is the only reason a single list is
 * meaningful at all. Neither the database's trigram rank nor a provider's
 * position can be compared across sources: they rank against different corpora,
 * so "first" means something different in each. Ties go to our own catalog,
 * which is §6.3's source of truth; below that the input order is preserved
 * (`Array.prototype.sort` is stable).
 *
 * **Deduplication is deliberately narrow.** An external record is dropped only
 * when its ISBN-13 is one our catalog already holds — a confirmed identity of
 * the same printing — and the local card is the one that stays, because only it
 * can offer the edition that already exists. Nothing else is treated as a
 * duplicate here: the same title is not evidence (namesakes exist), and two
 * printings of one work are two different books on a shelf. Hiding either would
 * take away the choice the list is shown for.
 *
 * External records are NOT deduplicated against each other here — `mergeResults`
 * on the server has already done that, with the metadata to do it properly.
 */
export function buildUnifiedResults<TLocal extends LocalCandidate>(
  query: string,
  candidates: readonly TLocal[],
  external: readonly ExternalSearchResult[],
): UnifiedResult<TLocal>[] {
  const alreadyLocal = localIsbns(candidates)

  const rows: UnifiedResult<TLocal>[] = [
    ...candidates.map((candidate): UnifiedResult<TLocal> => ({
      origin: 'LOCAL',
      key: `local:${candidate.work.id}`,
      score: localScore(query, candidate),
      candidate,
    })),
    ...external
      .filter((result) => result.isbn13 === undefined || !alreadyLocal.has(result.isbn13))
      .map((result): UnifiedResult<TLocal> => ({
        origin: 'EXTERNAL',
        key: `external:${result.id}`,
        score: relevanceOf(query, result).score,
        result,
      })),
  ]

  return rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score

    // Equal relevance: our own catalog first.
    if (left.origin !== right.origin) return left.origin === 'LOCAL' ? -1 : 1

    return 0
  })
}
