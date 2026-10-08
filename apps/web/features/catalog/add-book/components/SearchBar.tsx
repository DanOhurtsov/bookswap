'use client'

import { SearchIcon } from 'lucide-react'
import dynamic from 'next/dynamic'
import type { FormEvent } from 'react'
import type { UseFormRegisterReturn } from 'react-hook-form'
import { TextField } from '@/components/Form/FormFields'
import { Button } from '@/components/ui/button'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import type { AutoSearch } from '../model/use-auto-search'
import { SpellingSuggestion } from './SpellingSuggestion'

/**
 * Bundle-split boundary (§9): `next/dynamic` keeps the scanner panel — and its lazy `@zxing/*` import —
 * out of the initial `/catalog/new` chunk graph. The loader lives in its own module so tests can mock it.
 */
const BarcodeScannerPanel = dynamic(loadBarcodeScannerPanel, { ssr: false })

type SearchBarProps = {
  /** react-hook-form registration of the `q` field. */
  registration: UseFormRegisterReturn<'q'>
  /** IME composition handlers of the auto-search. */
  composition: AutoSearch['composition']
  error: string | undefined
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  /** Changing it remounts the scanner panel: an explicit search stops a camera that is still running. */
  scannerResetToken: number
  onScanned: (isbn: string) => void
  spellingText: string | undefined
  onPickSpelling: (text: string) => void
}

/** The query field, "Search", the scanner and the spelling hint under them. */
export function SearchBar({
  registration,
  composition,
  error,
  onSubmit,
  scannerResetToken,
  onScanned,
  spellingText,
  onPickSpelling,
}: SearchBarProps) {
  return (
    // Input, "Search" and scanner are one row: `BarcodeScannerPanel` sits in the same grid (`display: contents`).
    <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 gap-y-3">
      <form
        className="flex items-end gap-2 [&_.field]:relative [&_.field]:min-w-0 [&_.field]:flex-auto **:[[role=alert]]:absolute **:[[role=alert]]:top-[calc(100%+0.35rem)]"
        onSubmit={onSubmit}
        noValidate
      >
        <TextField
          id="search-query"
          label="Назва, автор або ISBN"
          autoComplete="off"
          hint="Мінімум два символи."
          error={error}
          {...registration}
          {...composition}
        />

        <Button
          type="submit"
          size="icon"
          className="size-11 cursor-pointer"
          aria-label="Шукати"
          title="Шукати"
        >
          <SearchIcon aria-hidden="true" className="size-4" />
        </Button>
      </form>

      <BarcodeScannerPanel key={scannerResetToken} onValidIsbn={onScanned} />

      {spellingText !== undefined && (
        <SpellingSuggestion text={spellingText} onPick={onPickSpelling} />
      )}
    </div>
  )
}
