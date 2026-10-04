import type { BookLookupResult } from '@bookswap/shared'
import { languageName } from '@/app/lib/language-names'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { SOURCE_LABELS } from './ExternalResultCard'
import { QuickAddActions } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type LookupAddCardProps = {
  isbn: string
  lookup: BookLookupResult
  slot: QuickAddSlot | undefined
  onAdd: (additional: boolean) => void
  onRetry: () => void
}

/** Видання, знайдене за точним ISBN у зовнішньому джерелі, якого ще немає в нашому каталозі. */
export function LookupAddCard({ isbn, lookup, slot, onAdd, onRetry }: LookupAddCardProps) {
  const source = lookup.source === undefined ? 'Зовнішнє джерело' : SOURCE_LABELS[lookup.source]

  return (
    <ResultCardShell
      // badge={source}
      coverUrl={lookup.coverUrl}
      coverAlt={`Обкладинка «${lookup.title}»`}
      title={<span className="book__title">{lookup.title}</span>}
      authors={lookup.authors === undefined ? undefined : <span>{lookup.authors.join(', ')}</span>}
      meta={[
        lookup.publisher,
        lookup.publishedYear === undefined ? undefined : String(lookup.publishedYear),
        lookup.language === undefined ? undefined : languageName(lookup.language),
      ]}
    >
      <details className="book__meta">
        <summary>Деталі видання</summary>
        <ul>
          <li>ISBN {isbn}</li>
          {lookup.pageCount !== undefined && <li>{lookup.pageCount} стор.</li>}
          <li>Знайдено за ISBN у {source}</li>
        </ul>
      </details>

      <QuickAddActions
        slot={slot}
        owned={slot?.status === 'done'}
        onAdd={onAdd}
        onRetry={onRetry}
      />
    </ResultCardShell>
  )
}
