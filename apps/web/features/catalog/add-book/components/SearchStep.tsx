'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  isValidIsbn13,
  searchCandidatesRequestSchema,
  type CopyEntryMethod,
  type ExternalSearchResult,
  type SearchCandidatesRequest,
} from '@bookswap/shared'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { searchAddBookCandidates, type AddBookSearchResult } from '../api/search-add-book'
import { findLocalDuplicates, searchExternalCatalogs } from '../api/search-external'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchReady,
  type ExternalSearchState,
} from '../model/external-search-state'
import {
  existingWorkFromExternal,
  newWorkFromExternal,
  type ExternalSelection,
} from '../model/external-selection'
import { ExternalSelectionPanel } from './ExternalSelectionPanel'
import { SearchResults } from './SearchResults'

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
  initialQuery: string
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

type ScanState = { result: AddBookSearchResult; entryMethod: CopyEntryMethod }

export function SearchStep({
  initialQuery,
  initialExternalSelection,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
}: SearchStepProps) {
  const [scanState, setScanState] = useState<ScanState>()
  const [failure, setFailure] = useState<unknown>()
  const [external, setExternal] = useState<ExternalSearchState>(IDLE_EXTERNAL_SEARCH)
  const [selection, setSelection] = useState<ExternalSelection>()
  const [scannerResetToken, setScannerResetToken] = useState(0)
  const requestIdRef = useRef(0)
  /**
   * Bumped by every action that abandons a selection, so an in-flight duplicate
   * check can tell it is no longer wanted. See `abandonSelection`.
   */
  const selectionIdRef = useRef(0)
  /**
   * How the CURRENT search was started, not how some earlier one was.
   *
   * Read from a ref rather than from `scanState`, because `scanState` still
   * holds the previous search's results while a new one is running: a scan
   * followed by a title search would otherwise tag the title match as
   * `BARCODE` and quietly corrupt the funnel (Stage 8a).
   */
  const entryMethodRef = useRef<CopyEntryMethod>('MANUAL')
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SearchCandidatesRequest>({
    resolver: zodResolver(searchCandidatesRequestSchema),
    defaultValues: { q: initialQuery },
  })

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
    setSelection(undefined)
  }

  /**
   * The shared path for manual and camera search — R2: no second copy of the
   * orchestration.
   *
   * Local and external search start together but do NOT wait for each other:
   * `runSearch` returns as soon as local candidates are ready, while the
   * external section arrives on its own state. Hence two independent `await`
   * chains rather than one `Promise.all`, which would hold local results for
   * exactly as long as the slowest external source thinks.
   */
  async function runSearch(query: string, entryMethod: CopyEntryMethod): Promise<void> {
    const requestId = ++requestIdRef.current

    entryMethodRef.current = entryMethod
    setFailure(undefined)
    abandonSelection()

    // A query that IS itself a valid ISBN does not go to external title search:
    // `/catalog/lookup` inside `searchAddBookCandidates` already answers it, and
    // a second call would spend somebody else's quota on the same question. The
    // existing ISBN behaviour is unchanged.
    const searchesExternally = !isValidIsbn13(query)

    setExternal(searchesExternally ? { status: 'loading' } : IDLE_EXTERNAL_SEARCH)

    if (searchesExternally) void runExternalSearch(query, requestId)

    try {
      const result = await searchAddBookCandidates(query)
      if (requestIdRef.current !== requestId) return

      setScanState({ result, entryMethod })
    } catch (error) {
      if (requestIdRef.current !== requestId) return

      setScanState(undefined)
      setFailure(error)
    }
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
   * Guard against a stale answer: a slow first request returning after a second
   * one must be discarded, not repaint fresh results. The same `requestIdRef`
   * as the local search — one counter per step, so a new search invalidates
   * both branches together.
   */
  async function runExternalSearch(query: string, requestId: number): Promise<void> {
    try {
      const response = await searchExternalCatalogs(query)
      if (requestIdRef.current !== requestId) return

      setExternal(externalSearchReady(response))
    } catch (error) {
      if (requestIdRef.current !== requestId) return

      setExternal({ status: 'failed', message: describeAddBookError(error) })
    }
  }

  /**
   * Picking an external record → duplicate check → form.
   *
   * No duplicates — straight to the creation form: an extra "found nothing,
   * press on" screen adds nothing. Duplicates — the decision is the user's
   * (`ExternalSelectionPanel`).
   *
   * `entryMethod` is captured from the ref, i.e. from the search that actually
   * produced this list, not from whatever `scanState` still holds.
   */
  const selectExternal = useCallback(
    async (result: ExternalSearchResult): Promise<void> => {
      const selectionId = ++selectionIdRef.current
      const entryMethod = entryMethodRef.current

      setSelection({ status: 'checking', result })

      try {
        const check = await findLocalDuplicates(result)
        if (!mountedRef.current || selectionIdRef.current !== selectionId) return

        if (check.candidates.length === 0) {
          setSelection(undefined)
          onCreateNew(newWorkFromExternal(result, entryMethod))
          return
        }

        setSelection({ status: 'duplicates', result, check })
      } catch (error) {
        if (!mountedRef.current || selectionIdRef.current !== selectionId) return

        setSelection({ status: 'failed', result, message: describeAddBookError(error) })
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

  async function submit({ q }: SearchCandidatesRequest): Promise<void> {
    // A manual search is always MANUAL and stops an active camera (remount below).
    setScannerResetToken((token) => token + 1)
    await runSearch(q, 'MANUAL')
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

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Шукаю…' : 'Шукати'}
        </button>
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
          void runSearch(isbn, 'BARCODE')
        }}
      />

      {failure !== undefined && <FormStatus error={new Error(describeAddBookError(failure))} />}
      {scanState?.result.lookupFailure !== undefined && (
        <p className="status status--pending">
          {describeAddBookError(scanState.result.lookupFailure)}
        </p>
      )}

      {/* One list for both halves of the search. While a selection is being
          checked the list gives way to the panel, so the person is answering
          one question at a time rather than choosing again underneath it. */}
      {scanState !== undefined && selection === undefined && (
        <SearchResults
          result={scanState.result}
          entryMethod={scanState.entryMethod}
          external={external}
          onFoundEdition={onFoundEdition}
          onFoundWork={onFoundWork}
          onCreateNew={onCreateNew}
          onSelectExternal={(result) => {
            void selectExternal(result)
          }}
        />
      )}

      {selection !== undefined && (
        <ExternalSelectionPanel
          selection={selection}
          onUseEdition={(workId, title, editionId) => {
            onFoundEdition({ workId, title, editionId, entryMethod: entryMethodRef.current })
          }}
          onUseWork={(workId, title, result, translations) => {
            onFoundWork(
              existingWorkFromExternal(workId, title, result, entryMethodRef.current, translations),
            )
          }}
          onCreateAnyway={(result) => {
            onCreateNew(newWorkFromExternal(result, entryMethodRef.current))
          }}
          onRetry={(result) => {
            void selectExternal(result)
          }}
          onCancel={abandonSelection}
        />
      )}
    </>
  )
}
