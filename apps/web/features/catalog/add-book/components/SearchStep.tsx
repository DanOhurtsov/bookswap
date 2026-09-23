'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  searchCandidatesRequestSchema,
  type CopyEntryMethod,
  type SearchCandidatesRequest,
} from '@bookswap/shared'
import dynamic from 'next/dynamic'
import { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { searchAddBookCandidates, type AddBookSearchResult } from '../api/search-add-book'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
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
  onFoundEdition: (selection: ExistingEditionInput) => void
  onFoundWork: (selection: ExistingWorkInput) => void
  onCreateNew: (selection: NewWorkInput) => void
}

type ScanState = { result: AddBookSearchResult; entryMethod: CopyEntryMethod }

export function SearchStep({
  initialQuery,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
}: SearchStepProps) {
  const [scanState, setScanState] = useState<ScanState>()
  const [failure, setFailure] = useState<unknown>()
  const [scannerResetToken, setScannerResetToken] = useState(0)
  const requestIdRef = useRef(0)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SearchCandidatesRequest>({
    resolver: zodResolver(searchCandidatesRequestSchema),
    defaultValues: { q: initialQuery },
  })

  /** Спільний шлях для ручного й camera-пошуку — R2: жодної другої orchestration-копії. */
  async function runSearch(query: string, entryMethod: CopyEntryMethod): Promise<void> {
    const requestId = ++requestIdRef.current
    setFailure(undefined)

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

  async function submit({ q }: SearchCandidatesRequest): Promise<void> {
    // Ручний пошук завжди MANUAL і зупиняє активну камеру (ремаунт нижче).
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
          hint="Мінімум два символи."
          error={errors.q?.message}
          {...register('q')}
        />

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Шукаю…' : 'Шукати'}
        </button>
      </form>

      {/* Панель рендериться завжди, в обох режимах, і її власна кнопка старту
          і є входом у сканування. Раніше вона висіла за `?mode=scan`, тому вхід
          вимагав навігації: клік → інша сторінка → друге натискання. Тут
          `startBarcodeScanner` викликається синхронно в обробнику кліку — той
          самий user gesture, що вимагає R2, лише без проміжного кроку. Саме для
          цього `<video>` усередині панелі монтується заздалегідь. */}
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
      {scanState !== undefined && (
        <SearchResults
          result={scanState.result}
          entryMethod={scanState.entryMethod}
          onFoundEdition={onFoundEdition}
          onFoundWork={onFoundWork}
          onCreateNew={onCreateNew}
        />
      )}
    </>
  )
}
