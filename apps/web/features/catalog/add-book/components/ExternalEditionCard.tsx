import type { ExternalSearchResult } from '@bookswap/shared'
import { languageName } from '@/app/lib/language-names'
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
 * Конкретне видання із зовнішнього джерела — та сама картка, що й у нашого видання; вибір відкриває
 * діалог з деталями, атрибуцією джерела й діями (BS-114).
 *
 * Показує лише те, що джерело справді повідомило: порожнє поле просто відсутнє — без прочерків і без
 * «невідомо» (§6.3, п. 7).
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
      meta={[
        result.publisher,
        result.publishedYear === undefined ? undefined : String(result.publishedYear),
        result.language === undefined ? undefined : languageName(result.language),
      ]}
      onSelect={onSelect}
    >
      <QuickAddStatus slot={slot} />
    </ResultCardShell>
  )
}
