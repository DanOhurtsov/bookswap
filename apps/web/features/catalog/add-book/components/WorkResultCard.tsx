import Link from 'next/link'
import type { AddSearchWorkItem } from '@bookswap/shared'
import { ResultCardShell } from './ResultCardShell'

/**
 * Твір, у якого ще немає жодного видання в нашому каталозі. Це абстрактний результат, а не конкретна
 * книжка: тут немає кнопки «Додати до бібліотеки», бо немає чого додавати, а обкладинка, ISBN чи
 * переклад не вигадуються.
 */
export function WorkResultCard({ item }: { item: AddSearchWorkItem }) {
  return (
    <ResultCardShell
      badge="Наш каталог"
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
      <Link href={`/catalog/new?mode=manual&workId=${encodeURIComponent(item.work.id)}`}>
        Уточнити видання
      </Link>{' '}
      <Link href={`/works/${item.work.id}`}>Відкрити твір</Link>
    </ResultCardShell>
  )
}
