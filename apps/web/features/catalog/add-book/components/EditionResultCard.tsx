import type { AddSearchEditionItem } from '@bookswap/shared'
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
 * One card = one SPECIFIC edition (docs/plan/fast-book-add.md, §2.1–2.2): cover, title, authors, the
 * edition's year. Choosing the card opens the dialog with the details (publisher, language, format, ISBN)
 * and the actions (BS-114); the card keeps the short state — «Додаю…», «✓ У моїй бібліотеці». Unknown
 * fields are not filled with guesses: an empty one is simply absent.
 */
export function EditionResultCard({ item, slot, onSelect }: EditionResultCardProps) {
  const { edition, work, authors, ownership } = item

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
      meta={[edition.year === null ? undefined : String(edition.year)]}
      onSelect={onSelect}
      selectTitle={work.title}
      status={<QuickAddStatus slot={slot} ownership={ownership} />}
    />
  )
}
