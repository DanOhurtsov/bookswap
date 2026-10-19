import type { ExternalSearchResult } from '@bookswap/shared'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { QuickAddStatus } from './QuickAddActions'
import { ResultCardShell } from './ResultCardShell'

type ExternalWorkCardProps = {
  result: ExternalSearchResult
  /** `undefined` for a work record the server cannot be pointed at. */
  slot: QuickAddSlot | undefined
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * A WORK record from an external source — not a specific edition. Its dialog says so and offers
 * «Додати до бібліотеки» (BS-114): the work, an "unspecified" edition and a copy whose publishing data is
 * unknown — and «Уточнити дані». The card shows the first publication year, captioned as such; an ISBN,
 * a publisher or a printing year is not invented from an aggregated record (docs/plan/fast-book-add.md, §2.4).
 */
export function ExternalWorkCard({ result, slot, onSelect }: ExternalWorkCardProps) {
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
        result.firstPublishedYear === undefined
          ? undefined
          : `Уперше видано ${String(result.firstPublishedYear)}`,
      ]}
      onSelect={onSelect}
      selectTitle={result.title}
      status={<QuickAddStatus slot={slot} />}
    />
  )
}
