import type { AddSearchWorkItem } from '@bookswap/shared'
import { ResultCardShell } from './ResultCardShell'

type WorkResultCardProps = {
  item: AddSearchWorkItem
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * Твір, у якого ще немає жодного видання в нашому каталозі. Це абстрактний результат, а не конкретна
 * книжка: його діалог пропонує лише «Уточнити дані», бо додавати нічого, а обкладинка, ISBN чи переклад
 * не вигадуються.
 */
export function WorkResultCard({ item, onSelect }: WorkResultCardProps) {
  return (
    <ResultCardShell
      coverAlt={`Обкладинка «${item.work.title}»`}
      title={<span className="book__title">{item.work.title}</span>}
      authors={
        item.authors.length === 0 ? undefined : (
          <span className="wrap-anywhere">
            {item.authors.map((author) => author.name).join(', ')}
          </span>
        )
      }
      meta={[
        item.work.firstPubYear === null
          ? undefined
          : `Уперше видано ${String(item.work.firstPubYear)}`,
      ]}
      onSelect={onSelect}
    >
      <span className="book__meta">Для цього твору ще немає конкретного видання.</span>
    </ResultCardShell>
  )
}
