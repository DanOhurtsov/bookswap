import Link from 'next/link'
import type { AddSearchEditionItem } from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { QuickAddActions } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type EditionResultCardProps = {
  item: AddSearchEditionItem
  /** Стан додавання цього видання в поточному сеансі; наявність на сервері — у `item.ownership`. */
  slot: QuickAddSlot | undefined
  /** `additional` — свідомо ще один фізичний примірник. */
  onAdd: (additional: boolean) => void
  onRetry: () => void
}

/**
 * Одна картка = одне КОНКРЕТНЕ видання з однією основною дією (docs/plan/fast-book-add.md, §2.1–2.2).
 *
 * Кнопка проходить стани «Додати до бібліотеки» → «Додаю…» → «✓ У моїй бібліотеці» (`QuickAddActions`).
 * Невідомі поля не заповнюються здогадками: порожнє просто відсутнє.
 */
export function EditionResultCard({ item, slot, onAdd, onRetry }: EditionResultCardProps) {
  const { edition, work, authors, ownership } = item
  const owned = slot?.status === 'done' || ownership.activeCount > 0
  const archivedOnly = !owned && ownership.archivedCount > 0
  const facts = [
    edition.publisher ?? undefined,
    edition.year === null ? undefined : String(edition.year),
    edition.lang === null ? undefined : languageName(edition.lang),
    edition.format === null ? undefined : EDITION_FORMAT_LABELS[edition.format],
  ]

  return (
    <ResultCardShell
      badge="Наш каталог"
      coverUrl={edition.coverUrl ?? undefined}
      coverAlt={`Обкладинка «${work.title}»`}
      title={<span className="book__title">{work.title}</span>}
      authors={
        authors.length === 0 ? undefined : <span>{authors.map((a) => a.name).join(', ')}</span>
      }
      meta={facts}
    >
      <details className="book__meta">
        <summary>Деталі видання</summary>
        <ul>
          {edition.isbn13 !== null && <li>ISBN {edition.isbn13}</li>}
          {edition.pageCount !== null && <li>{edition.pageCount} стор.</li>}
          {edition.translator !== null && <li>Перекладач: {edition.translator}</li>}
          <li>Джерело: каталог BookSwap</li>
        </ul>
      </details>

      {archivedOnly && (
        <span className="book__meta">
          Це видання є у вашому архіві. <Link href="/library?view=archive">Відновити з архіву</Link>
        </span>
      )}

      <QuickAddActions slot={slot} owned={owned} onAdd={onAdd} onRetry={onRetry} />
    </ResultCardShell>
  )
}
