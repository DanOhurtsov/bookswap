'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { catalogQuerySchema, type CatalogQuery, type CopyEntryMethod } from '@bookswap/shared'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { readSearchAddress } from '@/app/lib/search-page'
import { normalizeQuery } from '../model/auto-search'
import { visibleSpellingSuggestion } from '../model/external-search-state'
import { manualHref } from '../model/search-address-urls'
import { useAddSearchResults } from '../model/use-add-search-results'
import { useAutoSearch } from '../model/use-auto-search'
import type { QuickAddApi } from '../model/use-quick-add'
import { useSearchAddressSync } from '../model/use-search-address-sync'
import { ledeClass } from './screen-styles'
import { SearchBar } from './SearchBar'
import { SearchResults } from './SearchResults'

type AddBookSearchScreenProps = {
  /** The signed-in person: their search pages are cached apart from anyone else's. */
  viewerId: string
  quick: QuickAddApi
  /** The ISBN the scanner found last; while it is the query in the address, copies are added as scanned. */
  scannedQuery: string | undefined
  onScannedChange: (isbn: string | undefined) => void
}

/**
 * Search by title, author or ISBN; the scanner only fills the ISBN into the same search. Typing runs
 * the same full, paged search as «Шукати» once it pauses (BS-134).
 */
export function AddBookSearchScreen({
  viewerId,
  quick,
  scannedQuery,
  onScannedChange,
}: AddBookSearchScreenProps) {
  const router = useRouter()
  const parameters = useSearchParams()
  const address = readSearchAddress(parameters)
  const urlQuery = normalizeQuery(address.q)
  /** "Search" on an unchanged query asks AGAIN (a failed search is retried the same way). */
  const [refresh, setRefresh] = useState(0)
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
    // Not `values`: an address written by typing itself must not overwrite what the person keeps typing.
    defaultValues: { q: address.q },
  })
  const draft = useWatch({ control, name: 'q' })
  const nav = useSearchAddressSync({ router, parameters, pageSize: address.pageSize, q: address.q })
  const auto = useAutoSearch({
    draft,
    urlQuery,
    onSearch: nav.search,
    onClear: nav.clear,
    onExact: nav.exact,
  })
  const release = auto.release
  const adoptExternalAddress = nav.adoptExternal

  useEffect(() => {
    if (!adoptExternalAddress(address.q)) return

    setValue('q', address.q)
    // Back/Forward, the scanner, a link: the page in the address is shown at once, no pauses.
    release(normalizeQuery(address.q))
  }, [address.q, setValue, release, adoptExternalAddress])

  const { view, request, external, lookup, isbn, query, enabled } = useAddSearchResults({
    viewerId,
    address,
    refresh,
    externalReleased: auto.externalReleased,
    localPending: auto.localPending,
    typing: nav.typed,
  })
  // Which hint to show and whether to — `visibleSpellingSuggestion`: the external half has the last word,
  // and the old one disappears as soon as the text in the field stops matching the one it was computed for.
  const spellingText = visibleSpellingSuggestion(
    auto.normalized,
    view.response?.spellingSuggestion,
    external,
    normalizeQuery,
  )

  /** Explicit full search: pending launches are cancelled, and exactly one search runs, both halves at once. */
  function runFullSearch(text: string): void {
    auto.cancel()
    onScannedChange(undefined)
    setScannerResetToken((token) => token + 1)

    const q = normalizeQuery(text)

    release(q)
    if (q === urlQuery && address.page === 1) setRefresh((count) => count + 1)

    nav.pushFull(q)
  }

  return (
    <main className="page">
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

      {enabled && (
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
        />
      )}
      {/* Always available — also when external sources did not answer: the manual path depends on nothing. */}
      <p className="text-[1rem] text-(--bookswap-muted)">
        {enabled ? 'Не знайшли потрібну книжку?' : 'Щоб шукати, введіть назву, автора або ISBN.'}{' '}
        <Link
          href={manualHref({ parameters, isbn, query: enabled ? query : undefined })}
          className="link-underline text-(--bookswap-accent)"
        >
          Додати вручну
        </Link>
      </p>
    </main>
  )
}
