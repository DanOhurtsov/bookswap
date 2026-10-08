'use client'

import type {
  AddSearchEditionItem,
  AddSearchExternalItem,
  AddSearchResponse,
  BookLookupResult,
  CopyEntryMethod,
} from '@bookswap/shared'
import { useRouter } from 'next/navigation'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { searchHref, type SearchAddress } from '@/app/lib/search-page'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import { FormStatus } from '@/components/Form/FormStatus'
import { Button } from '@/components/ui/button'
import type { ExternalSearchState } from '../model/external-search-state'
import { externalIdentities, externalTarget } from '../model/external-target'
import { quickAddCardProps } from '../model/quick-add-card'
import { identitiesOf, isbnIdentity } from '../model/quick-add-identities'
import { ADD_BOOK_PATH } from '../model/search-address-urls'
import type { EmptyStateKind, SearchResultsView } from '../model/search-results-view'
import type { QuickAddApi } from '../model/use-quick-add'
import { EditionResultCard } from './EditionResultCard'
import { ExternalEditionCard } from './ExternalEditionCard'
import { ExternalSearchStatus } from './ExternalSearchStatus'
import { ExternalWorkCard } from './ExternalWorkCard'
import { LookupAddCard } from './LookupAddCard'
import { booksClass, emptyClass, pendingStatusClass, searchingStatusClass } from './screen-styles'
import { SearchPagination } from './SearchPagination'
import { WorkResultCard } from './WorkResultCard'

const EMPTY_STATE_TEXT: Record<EmptyStateKind, string> = {
  BLIND:
    'У BookSwap нічого схожого немає, а зовнішні каталоги не відповіли — чи є там ця книжка, невідомо.',
  AUTO_IDLE:
    'У нашому каталозі нічого схожого немає. Додайте символ або натисніть «Шукати» — тоді пошук піде й у зовнішні каталоги.',
  PLAIN: 'Нічого схожого не знайшлося.',
}

type EditionRowProps = {
  item: AddSearchEditionItem
  quick: QuickAddApi
  entryMethod: CopyEntryMethod
}

function EditionRow({ item, quick, entryMethod }: EditionRowProps) {
  return (
    <EditionResultCard
      item={item}
      {...quickAddCardProps(quick, entryMethod, identitiesOf(item), {
        kind: 'EXISTING_EDITION',
        editionId: item.edition.id,
      })}
    />
  )
}

type SearchResultsProps = {
  view: SearchResultsView<BookLookupResult>
  request: KeyedState<AddSearchResponse>
  lookup: KeyedState<BookLookupResult>
  external: ExternalSearchState<AddSearchExternalItem>
  /** Normalized ISBN when the executed query is one. */
  isbn: string | undefined
  address: SearchAddress
  parameters: URLSearchParams
  quick: QuickAddApi
  entryMethod: CopyEntryMethod
  /** Suggestions → the explicit full search of the same text. */
  onShowAll: () => void
}

/** Everything under the search bar: cards, statuses, the empty states and the page controls. */
export function SearchResults({
  view,
  request,
  lookup,
  external,
  isbn,
  address,
  parameters,
  quick,
  entryMethod,
  onShowAll,
}: SearchResultsProps) {
  const router = useRouter()
  const { response, items, externalItems, redundantLookup, lookupCard } = view

  return (
    <>
      {request.status === 'error' && <FormStatus error={describeAddBookError(request.error)} />}

      {lookupCard !== undefined && isbn !== undefined && (
        <ul className={booksClass}>
          <LookupAddCard
            isbn={isbn}
            lookup={lookupCard}
            {...quickAddCardProps(quick, entryMethod, [isbnIdentity(isbn)], {
              kind: 'EXTERNAL_EDITION',
              isbn13: isbn,
            })}
          />
        </ul>
      )}

      {(items.length > 0 || externalItems.length > 0) && (
        <ul className={booksClass}>
          {items.map((item) =>
            item.kind === 'WORK' ? (
              <WorkResultCard key={item.key} item={item} />
            ) : (
              <EditionRow key={item.key} item={item} quick={quick} entryMethod={entryMethod} />
            ),
          )}
          {externalItems.map((item) => {
            if (item.kind === 'EDITION') {
              return (
                <EditionRow key={item.key} item={item} quick={quick} entryMethod={entryMethod} />
              )
            }

            const target = externalTarget(item.result)

            if (target === undefined)
              return <ExternalWorkCard key={item.key} result={item.result} />

            return (
              <ExternalEditionCard
                key={item.key}
                result={item.result}
                {...quickAddCardProps(quick, entryMethod, externalIdentities(item.result), target)}
              />
            )
          })}
        </ul>
      )}

      <ExternalSearchStatus state={external} localLoading={view.localLoading} />

      {lookup.status === 'error' && !redundantLookup && response !== undefined && (
        <p className={pendingStatusClass}>{describeAddBookError(lookup.error)}</p>
      )}

      {view.showUnavailableNotice && (
        <p className={searchingStatusClass}>Зовнішній пошук тимчасово недоступний.</p>
      )}

      {view.emptyState !== undefined && (
        <p className={emptyClass}>{EMPTY_STATE_TEXT[view.emptyState]}</p>
      )}

      {view.pageEmpty && <p className={emptyClass}>На цій сторінці результатів немає.</p>}

      {view.showAllResults && (
        <Button type="button" variant="outline" className="cursor-pointer" onClick={onShowAll}>
          Показати всі результати
        </Button>
      )}

      {view.showPagination && (
        <SearchPagination
          page={address.page}
          pageSize={address.pageSize}
          next={view.next}
          currentHasRows={view.currentHasRows}
          hrefFor={(target) => searchHref(ADD_BOOK_PATH, parameters, { q: address.q, ...target })}
          onPageSizeChange={(pageSize) => {
            router.push(searchHref(ADD_BOOK_PATH, parameters, { q: address.q, page: 1, pageSize }))
          }}
        />
      )}
    </>
  )
}
