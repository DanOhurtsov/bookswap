'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  CATALOG_LIMITS,
  catalogQuerySchema,
  isValidIsbn13,
  normalizeIsbn13,
  type AddSearchExternalItem,
  type CatalogQuery,
  type CopyEntryMethod,
} from '@bookswap/shared'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { askedFor, readSearchAddress } from '@/app/lib/search-page'
import { useKeyedRequest } from '@/app/lib/use-keyed-request'
import {
  lookupIsbn,
  searchAddExternal,
  searchAddItems,
  suggestAddExternal,
  suggestAddItems,
} from '../api/add-search'
import { autoExternalView } from '../model/auto-external-view'
import {
  AUTO_EXTERNAL_MIN_CHARS,
  AUTO_LOCAL_MIN_CHARS,
  AUTO_PARAM,
  normalizeQuery,
} from '../model/auto-search'
import { visibleSpellingSuggestion, type ExternalSearchState } from '../model/external-search-state'
import { manualHref } from '../model/search-address-urls'
import { searchResultsView } from '../model/search-results-view'
import { useAutoSearch } from '../model/use-auto-search'
import { useExternalSearch } from '../model/use-external-search'
import { useLastReady } from '../model/use-last-ready'
import type { QuickAddApi } from '../model/use-quick-add'
import { useSearchAddressSync } from '../model/use-search-address-sync'
import { ledeClass, pageClass } from './screen-styles'
import { SearchBar } from './SearchBar'
import { SearchResults } from './SearchResults'

type AddBookSearchScreenProps = {
  quick: QuickAddApi
  /** The ISBN the scanner found last; while it is the query in the address, copies are added as scanned. */
  scannedQuery: string | undefined
  onScannedChange: (isbn: string | undefined) => void
}

/** Search by title, author or ISBN; the scanner only fills the ISBN into the same search. */
export function AddBookSearchScreen({
  quick,
  scannedQuery,
  onScannedChange,
}: AddBookSearchScreenProps) {
  const router = useRouter()
  const parameters = useSearchParams()
  const address = readSearchAddress(parameters)
  /** The address is in auto-suggestion mode: `q` is then the suggestions text, not an executed full search. */
  const autoMode = parameters.get(AUTO_PARAM) === '1'
  const query = address.q.trim()
  const urlQuery = normalizeQuery(address.q)
  /** Full search: only from an executed query, never from a draft. */
  const enabled = !autoMode && query.length >= CATALOG_LIMITS.queryMin
  const autoActive = autoMode && urlQuery.length >= AUTO_LOCAL_MIN_CHARS
  const showResults = enabled || autoActive
  /** "Search" on an unchanged query asks AGAIN (a failed search is retried the same way). */
  const [refresh, setRefresh] = useState(0)
  const searchKey = `${String(refresh)}\u0000${askedFor(query, address.page, address.pageSize)}`
  const [scannerResetToken, setScannerResetToken] = useState(0)
  const entryMethod: CopyEntryMethod = scannedQuery === address.q ? 'BARCODE' : 'MANUAL'

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<CatalogQuery>({
    resolver: zodResolver(catalogQuerySchema),
    // Not `values`: an address written by auto-search itself must not overwrite what the person keeps typing.
    defaultValues: { q: address.q },
  })
  const draft = useWatch({ control, name: 'q' })
  const nav = useSearchAddressSync({
    router,
    parameters,
    pageSize: address.pageSize,
    autoMode,
    q: address.q,
  })
  const auto = useAutoSearch({
    draft,
    urlQuery,
    autoMode,
    onSuggest: nav.suggest,
    onClear: nav.clear,
    onExact: nav.exact,
  })
  const restoreAuto = auto.restore
  const adoptExternalAddress = nav.adoptExternal

  useEffect(() => {
    if (!adoptExternalAddress(autoMode, address.q)) return

    setValue('q', address.q)
    restoreAuto(autoMode ? normalizeQuery(address.q) : undefined)
  }, [autoMode, address.q, setValue, restoreAuto, adoptExternalAddress])

  const request = useKeyedRequest(
    autoActive ? `auto\u0000${urlQuery}` : enabled ? searchKey : undefined,
    (signal) =>
      autoActive
        ? suggestAddItems(urlQuery, signal)
        : searchAddItems(query, address.page, address.pageSize, signal),
  )
  // External half of the full search: an independent request, local results do not wait for it. It lives
  // only on the EXECUTED query: a draft does not start it, and suggestion mode turns it off (the request
  // is cancelled, continuation stops).
  const externalAnswer = useExternalSearch<AddSearchExternalItem>(
    enabled ? query : '',
    address.page,
    address.pageSize,
    refresh,
    searchAddExternal,
  )
  // External suggestions: one request per text, no continuation, no repeats — the next one only comes from new text.
  const autoExternalAsked =
    autoActive &&
    urlQuery.length >= AUTO_EXTERNAL_MIN_CHARS &&
    !isValidIsbn13(urlQuery) &&
    auto.externalAsked === urlQuery
  const autoExternal = useKeyedRequest(
    autoExternalAsked ? `auto-external\u0000${urlQuery}` : undefined,
    (signal) => suggestAddExternal(urlQuery, signal),
  )
  // ISBN search: an exact match in external sources, when our catalog has no such edition yet.
  const isbn = !autoMode && isValidIsbn13(query) ? normalizeIsbn13(query) : undefined
  const lookup = useKeyedRequest(
    isbn !== undefined && address.page === 1 ? `${String(refresh)}\u0000isbn:${isbn}` : undefined,
    (signal) => lookupIsbn(isbn ?? '', signal),
  )
  const fresh = request.status === 'ready' ? request.value : undefined
  const staleLocal = useLastReady(fresh, autoActive)

  const external: ExternalSearchState<AddSearchExternalItem> = autoMode
    ? autoExternalView(urlQuery, autoExternalAsked, autoExternal)
    : externalAnswer
  const view = searchResultsView({
    enabled,
    autoActive,
    page: address.page,
    isbn,
    fresh,
    requestStatus: request.status,
    stale: staleLocal,
    external,
    lookup,
    localPending: auto.localPending,
  })
  // Which hint to show and whether to — `visibleSpellingSuggestion`: the external half has the last word,
  // and the old one disappears as soon as the text in the field stops matching the one it was computed for.
  const spellingText = visibleSpellingSuggestion(
    auto.normalized,
    view.response?.spellingSuggestion,
    external,
    normalizeQuery,
  )

  /** Explicit full search: pending launches are cancelled, and exactly one search runs. */
  function runFullSearch(text: string): void {
    auto.cancel()
    onScannedChange(undefined)
    setScannerResetToken((token) => token + 1)

    const q = normalizeQuery(text)

    if (!autoMode && q === urlQuery && address.page === 1) setRefresh((count) => count + 1)

    nav.pushFull(q)
  }

  return (
    <main className={pageClass}>
      <h1>Додати книжку</h1>
      <p className={ledeClass}>
        Знайдіть конкретне видання й додайте його до бібліотеки одним натисканням.
      </p>

      <SearchBar
        registration={register('q')}
        composition={auto.composition}
        error={errors.q?.message}
        onSubmit={(event) =>
          void handleSubmit(({ q }) => {
            runFullSearch(q)
          })(event)
        }
        scannerResetToken={scannerResetToken}
        onScanned={(scanned) => {
          onScannedChange(scanned)
          auto.cancel()
          nav.showScanned(scanned)
        }}
        spellingText={spellingText}
        onPickSpelling={(text) => {
          setValue('q', text)
          runFullSearch(text)
        }}
      />

      {showResults && (
        <SearchResults
          view={view}
          request={request}
          lookup={lookup}
          external={external}
          isbn={isbn}
          address={address}
          parameters={parameters}
          quick={quick}
          entryMethod={entryMethod}
          onShowAll={() => {
            runFullSearch(urlQuery)
          }}
        />
      )}
      {/* Always available — also when external sources did not answer: the manual path depends on nothing. */}
      <p className="text-[1rem] text-(--bookswap-muted)">
        {showResults
          ? 'Не знайшли потрібну книжку?'
          : 'Щоб шукати, введіть назву, автора або ISBN.'}{' '}
        <Link
          href={manualHref({ parameters, isbn, autoActive, enabled, urlQuery, query })}
          className="link-underline text-(--bookswap-accent)"
        >
          Додати вручну
        </Link>
      </p>
    </main>
  )
}
