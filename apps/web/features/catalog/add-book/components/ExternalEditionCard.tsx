import type { ExternalSearchResult } from '@bookswap/shared'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { QuickAddStatus } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type ExternalEditionCardProps = {
  result: ExternalSearchResult
  /** `undefined` too for an edition the server cannot be pointed at (no ISBN, no addressable record). */
  slot: QuickAddSlot | undefined
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * A specific edition from an external source — the same card as our own edition's; choosing it opens the
 * dialog with the details, the source attribution and the actions (BS-114).
 *
 * Shows only what the source actually reported: an empty field is simply absent — no dashes and no
 * «невідомо» (§6.3, item 7). The year is the printing year; the work-level first publication year an
 * edition may also carry stays in the dialog.
 */
export function ExternalEditionCard({ result, slot, onSelect }: ExternalEditionCardProps) {
  return (
    <ResultCardShell
      coverUrl={result.coverUrl}
      coverAlt={`Обкладинка «${result.title}»`}
      title={<span className="book__title">{result.title}</span>}
      authors={
        result.authors === undefined ? undefined : (
          <span className="wrap-anywhere">{result.authors.join(', ')}</span>
        )
      }
      meta={[result.publishedYear === undefined ? undefined : String(result.publishedYear)]}
      onSelect={onSelect}
      selectTitle={result.title}
      status={<QuickAddStatus slot={slot} />}
    />
  )
}
