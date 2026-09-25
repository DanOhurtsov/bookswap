import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ExternalSearchResult } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import {
  externalSearchBlind,
  externalSearchSettled,
  type ExternalSearchState,
} from '../model/external-search-state'
import type { LocalCandidate, UnifiedResult } from '../model/unified-results'
import { ExternalResultCard } from './ExternalResultCard'
import { ExternalSearchStatus } from './ExternalSearchStatus'
import { LocalResultCard } from './LocalResultCard'

/** The local half's state, reduced to what the list shows. */
export type LocalListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/** What a route decides about one of OUR cards: where it leads and what it offers. */
export type LocalCardActions = {
  href?: string
  note?: string
  searchedIsbn?: string
  onUseEdition?: (editionId: string) => void
  onUseWork?: () => void
}

type SearchResultsListProps<TLocal extends LocalCandidate> = {
  /** Already normalized and in server order — see `buildUnifiedResults`. */
  rows: UnifiedResult<TLocal>[]
  local: LocalListState
  external: ExternalSearchState
  page: number
  /** Where "back to the start" leads, for a page beyond the end of the list. */
  firstPageHref: string
  /** What our own card does on THIS route. */
  localCard: (candidate: TLocal) => LocalCardActions
  /** What choosing an external record does on THIS route. */
  onSelectExternal: (result: ExternalSearchResult) => void
  /**
   * The route's own words and next step for "the first page found nothing".
   * `blind` — the external half knew nothing (nobody managed to look).
   */
  emptyNotice: (context: { blind: boolean }) => ReactNode
}

/**
 * The result list of the shared search — the SAME component on `/catalog` and in
 * the add-book wizard (`/catalog/new`). What differs between the routes is what
 * happens AFTER a result is chosen, and that arrives as `localCard`,
 * `onSelectExternal` and `emptyNotice`; rendering the cards, the states and the
 * empty-list rules is done once, here.
 *
 * **States are kept apart, and neither hides the other**: our own catalog's
 * "searching…"/error sits above the list, the external half is one status line
 * below it. Local rows appear as soon as the local request answers; external
 * ones join the same list when they arrive.
 *
 * **"Nothing found" is said only when both halves finished and the external
 * page is complete.** While a source is still being asked — or a deep page is
 * still being loaded block by block — an empty list means "not yet". A failed
 * source is never worded as an absent book.
 */
export function SearchResultsList<TLocal extends LocalCandidate>({
  rows,
  local,
  external,
  page,
  firstPageHref,
  localCard,
  onSelectExternal,
  emptyNotice,
}: SearchResultsListProps<TLocal>) {
  const finished = local.status === 'ready' && externalSearchSettled(external)

  return (
    <>
      {local.status === 'loading' && <p className="status status--pending">Шукаю…</p>}
      {local.status === 'error' && <FormStatus error={new Error(local.message)} />}

      {rows.length > 0 && (
        <ul className="books">
          {rows.map((row) =>
            row.origin === 'LOCAL' ? (
              <LocalResultCard
                key={row.key}
                candidate={row.candidate}
                {...localCard(row.candidate)}
              />
            ) : (
              <ExternalResultCard
                key={row.key}
                result={row.result}
                onSelect={() => {
                  onSelectExternal(row.result)
                }}
              />
            ),
          )}
        </ul>
      )}

      <ExternalSearchStatus state={external} />

      {finished && rows.length === 0 && page > 1 && (
        <p className="empty">
          На цій сторінці результатів немає.{' '}
          <Link href={firstPageHref}>Повернутися на початок списку</Link>
        </p>
      )}

      {finished &&
        rows.length === 0 &&
        page === 1 &&
        emptyNotice({ blind: externalSearchBlind(external) })}
    </>
  )
}
