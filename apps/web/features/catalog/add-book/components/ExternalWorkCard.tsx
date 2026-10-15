import type { ExternalSearchResult } from '@bookswap/shared'
import { ResultCardShell } from './ResultCardShell'

type ExternalWorkCardProps = {
  result: ExternalSearchResult
  onSelect: (trigger: HTMLButtonElement) => void
}

/**
 * Запис про ТВІР із зовнішнього джерела — не конкретне видання. Його діалог не пропонує «Додати до
 * бібліотеки»: ISBN, видавництво чи обкладинка видання з агрегованих результатів не вигадуються
 * (docs/plan/fast-book-add.md, §2.4). Лишається «Уточнити дані» з відомими даними твору.
 */
export function ExternalWorkCard({ result, onSelect }: ExternalWorkCardProps) {
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
    </ResultCardShell>
  )
}
