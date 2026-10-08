import Link from 'next/link'
import type { ExternalSearchResult } from '@bookswap/shared'
import { manualFormHref } from '../model/search-address-urls'
import { ResultCardShell } from './ResultCardShell'

/**
 * «Уточнити видання»: та сама ручна форма із відомими даними запису (назва, автори, рік першого видання).
 * Обкладинка, ISBN чи переклад з агрегованого запису про твір не переносяться — їх людина вкаже сама.
 */
function refineHref(result: ExternalSearchResult, current: URLSearchParams): string {
  const prefill = new URLSearchParams({ title: result.title })

  for (const author of result.authors ?? []) prefill.append('author', author)

  if (result.firstPublishedYear !== undefined) {
    prefill.set('firstPubYear', String(result.firstPublishedYear))
  }

  return manualFormHref(prefill, current)
}

type ExternalWorkCardProps = {
  result: ExternalSearchResult
  /** The search address: the manual form keeps its context for the way back. */
  parameters: URLSearchParams
}

/**
 * Запис про ТВІР із зовнішнього джерела — не конкретне видання. Тут немає кнопки «Додати до бібліотеки»:
 * ISBN, видавництво чи обкладинка видання з агрегованих результатів не вигадуються (docs/plan/fast-book-add.md,
 * §2.4). Конкретне видання знаходять за ISBN або додають вручну.
 */
export function ExternalWorkCard({ result, parameters }: ExternalWorkCardProps) {
  return (
    <ResultCardShell
      coverUrl={result.coverUrl}
      coverAlt={`Обкладинка «${result.title}»`}
      title={<span className="book__title">{result.title}</span>}
      authors={result.authors === undefined ? undefined : <span>{result.authors.join(', ')}</span>}
      meta={[
        result.firstPublishedYear === undefined
          ? undefined
          : `Уперше видано ${String(result.firstPublishedYear)}`,
      ]}
    >
      <span className="book__meta">
        Запис про твір, а не про конкретне видання. Знайдіть видання за ISBN або уточніть його
        вручну.
      </span>
      <Link href={refineHref(result, parameters)}>Уточнити видання</Link>
    </ResultCardShell>
  )
}
