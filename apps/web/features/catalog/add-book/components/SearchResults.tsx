'use client'

import type {
  AddSearchExternalItem,
  AddSearchItem,
  AddSearchResponse,
  BookLookupResult,
  CopyEntryMethod,
} from '@bookswap/shared'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { searchHref, type SearchAddress } from '@/app/lib/search-page'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import { FormStatus } from '@/components/Form/FormStatus'
import { Button } from '@/components/ui/button'
import { addResultView, type AddResultSubject } from '../model/add-result-view'
import type { ExternalSearchState } from '../model/external-search-state'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { ADD_BOOK_PATH } from '../model/search-address-urls'
import type { EmptyStateKind, SearchResultsView } from '../model/search-results-view'
import type { QuickAddApi } from '../model/use-quick-add'
import { AddResultDialog } from './AddResultDialog'
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
  // The chosen result is a snapshot: the list may move on underneath, the dialog keeps its subject.
  // It stays after closing so the content does not vanish while the dialog animates out.
  // `trigger` — the card button that opened it: focus goes back there.
  const [chosen, setChosen] = useState<{
    subject: AddResultSubject
    trigger: HTMLButtonElement
    open: boolean
  }>()

  function choose(subject: AddResultSubject): (trigger: HTMLButtonElement) => void {
    return (trigger) => {
      setChosen({ subject, trigger, open: true })
    }
  }

  /** The card's add state: the same slot its dialog acts on. */
  function slotOf(subject: AddResultSubject): QuickAddSlot | undefined {
    const { quickAdd } = addResultView(subject)

    return quickAdd === undefined ? undefined : quick.slotFor(quickAdd.identities)
  }

  function card(item: AddSearchItem | AddSearchExternalItem): ReactNode {
    if (item.kind === 'WORK') {
      return <WorkResultCard key={item.key} item={item} onSelect={choose({ kind: 'WORK', item })} />
    }

    if (item.kind === 'EDITION') {
      const subject: AddResultSubject = { kind: 'EDITION', item }

      return (
        <EditionResultCard
          key={item.key}
          item={item}
          slot={slotOf(subject)}
          onSelect={choose(subject)}
        />
      )
    }

    const subject: AddResultSubject = { kind: 'EXTERNAL', result: item.result }

    return item.result.kind === 'WORK' ? (
      <ExternalWorkCard key={item.key} result={item.result} onSelect={choose(subject)} />
    ) : (
      <ExternalEditionCard
        key={item.key}
        result={item.result}
        slot={slotOf(subject)}
        onSelect={choose(subject)}
      />
    )
  }

  return (
    <>
      {request.status === 'error' && <FormStatus error={describeAddBookError(request.error)} />}

      {lookupCard !== undefined && isbn !== undefined && (
        <ul className={booksClass}>
          <LookupAddCard
            lookup={lookupCard}
            slot={slotOf({ kind: 'LOOKUP', isbn, lookup: lookupCard })}
            onSelect={choose({ kind: 'LOOKUP', isbn, lookup: lookupCard })}
          />
        </ul>
      )}

      {(items.length > 0 || externalItems.length > 0) && (
        <ul className={booksClass}>
          {/* Two lists, two key spaces: the halves are paged apart and may know the same edition. */}
          {items.map(card)}
          {externalItems.map(card)}
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

      <AddResultDialog
        view={chosen === undefined ? undefined : addResultView(chosen.subject)}
        open={chosen?.open === true}
        quick={quick}
        entryMethod={entryMethod}
        parameters={parameters}
        trigger={chosen?.trigger}
        onClose={() => {
          setChosen((current) => current && { ...current, open: false })
        }}
      />

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
