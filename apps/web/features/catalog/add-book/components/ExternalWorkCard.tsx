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
 * Запис про ТВІР із зовнішнього джерела — не конкретне видання. Діалог пропонує «Додати до бібліотеки»
 * (BS-114): твір, видання «без уточнення» й примірник, де видавничі дані невідомі, — і «Уточнити дані».
 * ISBN, видавництво чи рік видання з агрегованого запису не вигадуються (docs/plan/fast-book-add.md, §2.4).
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
    >
      <span className="book__meta">Запис про твір, а не про конкретне видання.</span>
      <QuickAddStatus slot={slot} />
    </ResultCardShell>
  )
}
