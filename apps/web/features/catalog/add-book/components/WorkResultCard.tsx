import Link from 'next/link'
import type { AddSearchWorkItem } from '@bookswap/shared'
import { manualFormHref } from '../model/search-address-urls'
import { ResultCardShell } from './ResultCardShell'

type WorkResultCardProps = {
  item: AddSearchWorkItem
  /** The search address: the manual form keeps its context for the way back. */
  parameters: URLSearchParams
}

/**
 * Твір, у якого ще немає жодного видання в нашому каталозі. Це абстрактний результат, а не конкретна
 * книжка: тут немає кнопки «Додати до бібліотеки», бо немає чого додавати, а обкладинка, ISBN чи
 * переклад не вигадуються.
 */
export function WorkResultCard({ item, parameters }: WorkResultCardProps) {
  return (
    <ResultCardShell
      coverAlt={`Обкладинка «${item.work.title}»`}
      title={<span className="book__title">{item.work.title}</span>}
      authors={
        item.authors.length === 0 ? undefined : (
          <span>{item.authors.map((author) => author.name).join(', ')}</span>
        )
      }
      meta={[
        item.work.firstPubYear === null
          ? undefined
          : `Уперше видано ${String(item.work.firstPubYear)}`,
      ]}
    >
      <span className="book__meta">Для цього твору ще немає конкретного видання.</span>
      <Link href={manualFormHref(new URLSearchParams({ workId: item.work.id }), parameters)}>
        Уточнити видання
      </Link>{' '}
      <Link href={`/works/${item.work.id}`}>Відкрити твір</Link>
    </ResultCardShell>
  )
}
