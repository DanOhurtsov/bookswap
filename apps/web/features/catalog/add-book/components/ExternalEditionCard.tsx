import type { ExternalSearchResult } from '@bookswap/shared'
import { languageName } from '@/app/lib/language-names'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { SOURCE_LABELS } from './ExternalResultCard'
import { QuickAddActions } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type ExternalEditionCardProps = {
  result: ExternalSearchResult
  slot: QuickAddSlot | undefined
  onAdd: (additional: boolean) => void
  onRetry: () => void
}

/**
 * Конкретне видання із зовнішнього джерела: та сама одна дія «Додати до бібліотеки», що й у нашого видання.
 *
 * Показує лише те, що джерело справді повідомило: порожнє поле просто відсутнє — без прочерків і без
 * «невідомо» (§6.3, п. 7). Обов'язкові посилання на джерело зберігаються бейджем і рядком у деталях.
 */
export function ExternalEditionCard({ result, slot, onAdd, onRetry }: ExternalEditionCardProps) {
  const sources = result.sources.map((source) => SOURCE_LABELS[source]).join(' · ')

  return (
    <ResultCardShell
      badge={sources}
      coverUrl={result.coverUrl}
      coverAlt={`Обкладинка «${result.title}»`}
      title={<span className="book__title">{result.title}</span>}
      authors={result.authors === undefined ? undefined : <span>{result.authors.join(', ')}</span>}
      meta={[
        result.publisher,
        result.publishedYear === undefined ? undefined : String(result.publishedYear),
        result.language === undefined ? undefined : languageName(result.language),
      ]}
    >
      <details className="book__meta">
        <summary>Деталі видання</summary>
        <ul>
          {result.isbn13 !== undefined && <li>ISBN {result.isbn13}</li>}
          {result.pageCount !== undefined && <li>{result.pageCount} стор.</li>}
          {result.firstPublishedYear !== undefined && (
            <li>Уперше видано {result.firstPublishedYear}</li>
          )}
          <li>Джерело: {sources}</li>
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
