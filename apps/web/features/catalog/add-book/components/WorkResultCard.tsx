import type { AddSearchWorkItem } from '@bookswap/shared'
import { ResultCardShell } from './ResultCardShell'

type WorkResultCardProps = {
  item: AddSearchWorkItem
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * A work with no edition in our catalog yet. It is an abstract result, not a specific book: its dialog
 * offers only «Уточнити дані» and says why — there is nothing to add, and a cover, an ISBN or a
 * translation is not invented. The card shows the first publication year, captioned as such.
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
      selectTitle={item.work.title}
    />
  )
}
