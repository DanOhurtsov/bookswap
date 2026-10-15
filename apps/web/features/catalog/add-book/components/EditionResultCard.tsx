import type { AddSearchEditionItem } from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { QuickAddStatus } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type EditionResultCardProps = {
  item: AddSearchEditionItem
  /** Стан додавання цього видання в поточному сеансі; наявність на сервері — у `item.ownership`. */
  slot: QuickAddSlot | undefined
  /** Opens the dialog with this edition's details and actions (BS-114). */
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * Одна картка = одне КОНКРЕТНЕ видання (docs/plan/fast-book-add.md, §2.1–2.2). Вибір картки відкриває
 * діалог із деталями й діями (BS-114); на картці лишається короткий стан — «Додаю…», «✓ У моїй бібліотеці».
 * Невідомі поля не заповнюються здогадками: порожнє просто відсутнє.
 */
export function EditionResultCard({ item, slot, onSelect }: EditionResultCardProps) {
  const { edition, work, authors, ownership } = item
  const facts = [
    edition.publisher ?? undefined,
    edition.year === null ? undefined : String(edition.year),
    edition.lang === null ? undefined : languageName(edition.lang),
    edition.format === null ? undefined : EDITION_FORMAT_LABELS[edition.format],
  ]

  return (
    <ResultCardShell
      coverUrl={edition.coverUrl ?? undefined}
      coverAlt={`Обкладинка «${work.title}»`}
      title={<span className="book__title">{work.title}</span>}
      authors={
        authors.length === 0 ? undefined : (
          <span className="wrap-anywhere">{authors.map((a) => a.name).join(', ')}</span>
        )
      }
      meta={facts}
      onSelect={onSelect}
    >
      <QuickAddStatus slot={slot} ownership={ownership} />
    </ResultCardShell>
  )
}
