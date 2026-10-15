import type { BookLookupResult } from '@bookswap/shared'
import { languageName } from '@/app/lib/language-names'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { QuickAddStatus } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type LookupAddCardProps = {
  lookup: BookLookupResult
  slot: QuickAddSlot | undefined
  onSelect: (trigger: HTMLButtonElement) => void
}

/** The edition an exact ISBN search found in an external source; its dialog adds it by that ISBN. */
export function LookupAddCard({ lookup, slot, onSelect }: LookupAddCardProps) {
  return (
    <ResultCardShell
      coverUrl={lookup.coverUrl}
      coverAlt={`Обкладинка «${lookup.title}»`}
      title={<span className="book__title">{lookup.title}</span>}
      authors={
        lookup.authors === undefined ? undefined : (
          <span className="wrap-anywhere">{lookup.authors.join(', ')}</span>
        )
      }
      meta={[
        lookup.publisher,
        lookup.publishedYear === undefined ? undefined : String(lookup.publishedYear),
        lookup.language === undefined ? undefined : languageName(lookup.language),
      ]}
      onSelect={onSelect}
    >
      <QuickAddStatus slot={slot} />
    </ResultCardShell>
  )
}
