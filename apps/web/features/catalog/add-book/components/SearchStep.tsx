'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  CATALOG_LIMITS,
  catalogQuerySchema,
  type CatalogQuery,
  type CopyEntryMethod,
  type ExternalSearchResult,
} from '@bookswap/shared'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { askedFor, type SearchAddress } from '@/app/lib/search-page'
import { useKeyedRequest } from '@/app/lib/use-keyed-request'
import { TextField } from '@/components/Form/FormFields'
import { searchAddBookCandidates } from '../api/search-add-book'
import { findLocalDuplicates } from '../api/search-external'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
import {
  existingWorkFromExternal,
  newWorkFromExternal,
  type ExternalSelection,
} from '../model/external-selection'
import { useExternalSearch } from '../model/use-external-search'
import { ExternalSelectionPanel } from './ExternalSelectionPanel'
import { SearchResults } from './SearchResults'
import type { LocalListState } from './SearchResultsList'

/**
 * Bundle-split boundary (§9): `next/dynamic` keeps the scanner panel — and
 * therefore its own lazy `@zxing/*` import — out of the initial
 * `/catalog/new` chunk graph. A bare `import()` inside a plain component
 * still got merged into the parent chunk by Turbopack's production
 * chunking; `next/dynamic` is the boundary Next.js itself enforces. The
 * loader lives in its own named module (not an inline closure here) so
 * tests can mock it by path — see `load-barcode-scanner-panel.ts`.
 */
const BarcodeScannerPanel = dynamic(loadBarcodeScannerPanel, { ssr: false })

type SearchStepProps = {
  /**
   * The search the ADDRESS asks for: query, page and page size. The address is the
   * single source of truth — a direct link, Back/Forward and a reload all restore
   * the list, because the list is derived from it and from nothing else.
   */
  address: SearchAddress
  /** Address of a page of this route; keeps the wizard's own parameters. */
  hrefFor: (target: SearchAddress) => string
  /** Move the address (push). The step never changes the search any other way. */
  onNavigate: (target: SearchAddress) => void
  /**
   * A record already chosen on `/catalog`.
   *
   * The step resumes with it instead of a blank search: the duplicate check
   * starts at once and the person is never asked to find and pick the same book
   * a second time. Nothing is written to the database by this — the wizard's own
   * steps still do that, after confirmation.
   */
  initialExternalSelection?: ExternalSearchResult
  onFoundEdition: (selection: ExistingEditionInput) => void
  onFoundWork: (selection: ExistingWorkInput) => void
  onCreateNew: (selection: NewWorkInput) => void
}

export function SearchStep({
  address,
  hrefFor,
  onNavigate,
  initialExternalSelection,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
}: SearchStepProps) {
  const query = address.q.trim()
  const enabled = query.length >= CATALOG_LIMITS.queryMin
  /**
   * Pressing "Шукати" on an unchanged query moves no address, yet it is a request
   * to search AGAIN (it is also how a failed search is retried). `refresh` makes
   * that a new key: both halves ask again, and a selection made under the previous
   * answer is dropped along with any duplicate check still in flight.
   */
  const [refresh, setRefresh] = useState(0)
  const searchKey = `${String(refresh)}\u0000${askedFor(query, address.page, address.pageSize)}`

  /**
   * The query that came from the camera. Whether the CURRENT search is a scan is
   * derived from it, not remembered as a flag: a scan followed by a typed search
   * would otherwise tag the title match as `BARCODE` and quietly corrupt the funnel
   * (Stage 8a). It lives in the component, not the address, so after a reload the
   * search is restored as `MANUAL`.
   */
  const [scannedQuery, setScannedQuery] = useState<string>()
  const entryMethod: CopyEntryMethod = scannedQuery === address.q ? 'BARCODE' : 'MANUAL'
  const entryMethodRef = useRef<CopyEntryMethod>(entryMethod)

  const [selectionState, setSelectionState] = useState<{
    key: string
    value: ExternalSelection
  }>()
  const [scannerResetToken, setScannerResetToken] = useState(0)
  /**
   * Bumped by every action that abandons a selection, so an in-flight duplicate
   * check can tell it is no longer wanted. See `abandonSelection`.
   */
  const selectionIdRef = useRef(0)
  const searchKeyRef = useRef(searchKey)

  useEffect(() => {
    entryMethodRef.current = entryMethod
    searchKeyRef.current = searchKey
  })

  // A selection belongs to the search it was made under. Back/Forward or a new
  // query moves the address, and the panel for a record chosen in another list
  // must not linger over this one.
  const selection = selectionState?.key === searchKey ? selectionState.value : undefined

  // Both halves are asked for the same page, in parallel and independently:
  // local results must not wait on the slowest external source. Each is keyed
  // by (query, page, size), so an answer to any other key is never painted.
  const localRequest = useKeyedRequest(enabled ? searchKey : undefined, (signal) =>
    searchAddBookCandidates(query, address.page, address.pageSize, signal),
  )
  const external = useExternalSearch(query, address.page, address.pageSize, refresh)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CatalogQuery>({
    resolver: zodResolver(catalogQuerySchema),
    values: { q: address.q },
  })

  const local: LocalListState =
    localRequest.status === 'error'
      ? { status: 'error', message: describeAddBookError(localRequest.error) }
      : { status: localRequest.status }
  const result = localRequest.status === 'ready' ? localRequest.value : undefined

  /**
   * Drops the current selection AND invalidates any duplicate check still in
   * flight for it.
   *
   * Hiding the panel is not enough. A check that resolves afterwards would pass
   * its own staleness guard and, finding no duplicates, call `onCreateNew` —
   * switching the wizard to a creation form for a record the user has already
   * walked away from. Bumping the counter is what makes that answer arrive too
   * late to matter.
   */
  function abandonSelection(): void {
    selectionIdRef.current += 1
    setSelectionState(undefined)
  }

  /**
   * Whether this step is still on screen.
   *
   * A check resolving after the step is gone must not call back into a wizard
   * that has already moved on — but the flag has to come BACK to `true` on a
   * remount, which is why it is a lifecycle flag and not another bump of
   * `selectionIdRef`. In StrictMode React mounts, unmounts and remounts the
   * same instance synchronously; bumping the counter there invalidated a check
   * that was still perfectly current, and a selection resumed from `/catalog`
   * then sat on "Перевіряю…" forever, because its answer was discarded and
   * nothing asked again. Same reasoning, and the same shape, as `mounted` in
   * `useWork`.
   */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  /**
   * Picking an external record → duplicate check → form.
   *
   * No duplicates — straight to the creation form: an extra "found nothing,
   * press on" screen adds nothing. Duplicates — the decision is the user's
   * (`ExternalSelectionPanel`).
   *
   * The check is INDEPENDENT of the page being viewed: `findLocalDuplicates`
   * asks the candidates endpoint for the first screen of matches for this very
   * record (by ISBN, then title and author), never for "what is on this page".
   *
   * An answer is discarded when the step is gone, when the selection was
   * abandoned, or when the address moved on to another search meanwhile.
   * `entryMethod` is read from the ref, i.e. from the search that produced this
   * list.
   */
  const selectExternal = useCallback(
    async (record: ExternalSearchResult): Promise<void> => {
      const selectionId = ++selectionIdRef.current
      const key = searchKeyRef.current
      const method = entryMethodRef.current
      const current = (): boolean =>
        mountedRef.current && selectionIdRef.current === selectionId && searchKeyRef.current === key

      setSelectionState({ key, value: { status: 'checking', result: record } })

      try {
        const check = await findLocalDuplicates(record)
        if (!current()) return

        if (check.candidates.length === 0) {
          setSelectionState(undefined)
          onCreateNew(newWorkFromExternal(record, method))
          return
        }

        setSelectionState({ key, value: { status: 'duplicates', result: record, check } })
      } catch (error) {
        if (!current()) return

        setSelectionState({
          key,
          value: { status: 'failed', result: record, message: describeAddBookError(error) },
        })
      }
    },
    [onCreateNew],
  )

  /**
   * Resuming a record chosen on `/catalog`.
   *
   * Guarded by the record's own id, not by "has this effect run": `onCreateNew`
   * may change identity and re-run the effect, and checking the same record
   * twice would cancel the first check through `selectionIdRef` — leaving a
   * panel that never resolves.
   */
  const resumedRef = useRef<string>(undefined)

  useEffect(() => {
    if (initialExternalSelection === undefined) return
    if (resumedRef.current === initialExternalSelection.id) return

    resumedRef.current = initialExternalSelection.id
    void selectExternal(initialExternalSelection)
  }, [initialExternalSelection, selectExternal])

  function submit({ q }: CatalogQuery): void {
    // A new search abandons the selection AT ONCE, in this very handler: the
    // address change below reaches the key only after a render, and a duplicate
    // check answering in between must already find itself unwanted.
    abandonSelection()
    // A manual search is always MANUAL and stops an active camera (remount below).
    setScannedQuery(undefined)
    setScannerResetToken((token) => token + 1)
    // A new query starts from page 1 and keeps the chosen page size.
    const next = { q, page: 1, pageSize: address.pageSize }

    if (next.q === address.q && next.page === address.page) setRefresh((count) => count + 1)

    onNavigate(next)
  }

  return (
    <>
      <form className="form" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <TextField
          id="search-query"
          label="Назва або ISBN"
          autoComplete="off"
          hint="Мінімум два символи. Шукаємо у BookSwap і в зовнішніх каталогах."
          error={errors.q?.message}
          {...register('q')}
        />

        <button type="submit">Шукати</button>
      </form>

      {/* The panel is always rendered, in both modes, and its own start button is
          the entry point into scanning. It used to sit behind `?mode=scan`, so
          entering required navigation: click → another page → a second press.
          Here `startBarcodeScanner` is called synchronously in the click
          handler — the same user gesture R2 requires, just without the
          intermediate step. That is why the `<video>` inside the panel is
          mounted up front. */}
      <BarcodeScannerPanel
        key={scannerResetToken}
        onValidIsbn={(isbn) => {
          abandonSelection()
          setScannedQuery(isbn)
          onNavigate({ q: isbn, page: 1, pageSize: address.pageSize })
        }}
      />

      {result?.lookupFailure !== undefined && (
        <p className="status status--pending">{describeAddBookError(result.lookupFailure)}</p>
      )}

      {/* One list for both halves of the search, and the same component as
          `/catalog`. While a selection is being checked the list gives way to the
          panel, so the person is answering one question at a time rather than
          choosing again underneath it. */}
      {enabled && selection === undefined && (
        <SearchResults
          result={result}
          local={local}
          entryMethod={entryMethod}
          external={external}
          page={address.page}
          pageSize={address.pageSize}
          query={query}
          hrefFor={(target) => hrefFor({ q: address.q, ...target })}
          onPageSizeChange={(pageSize) => {
            onNavigate({ q: address.q, page: 1, pageSize })
          }}
          onFoundEdition={onFoundEdition}
          onFoundWork={onFoundWork}
          onCreateNew={onCreateNew}
          onSelectExternal={(record) => {
            void selectExternal(record)
          }}
        />
      )}

      {selection !== undefined && (
        <ExternalSelectionPanel
          selection={selection}
          onUseEdition={(workId, title, editionId) => {
            onFoundEdition({ workId, title, editionId, entryMethod: entryMethodRef.current })
          }}
          onUseWork={(workId, title, record, translations) => {
            onFoundWork(
              existingWorkFromExternal(workId, title, record, entryMethodRef.current, translations),
            )
          }}
          onCreateAnyway={(record) => {
            onCreateNew(newWorkFromExternal(record, entryMethodRef.current))
          }}
          onRetry={(record) => {
            void selectExternal(record)
          }}
          onCancel={abandonSelection}
        />
      )}
    </>
  )
}
