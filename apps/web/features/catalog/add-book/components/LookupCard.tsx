import Image from 'next/image'
import type { BookLookupResult, BookLookupSource } from '@bookswap/shared'

type LookupCardProps = {
  isbn?: string
  lookup: BookLookupResult
  onUse?: () => void
}

const SOURCE_LABELS: Record<BookLookupSource, string> = {
  OPEN_LIBRARY: 'Open Library',
  GOOGLE_BOOKS: 'Google Books',
  ISBNDB: 'ISBNdb',
}

/** External metadata is only an editable draft; this card never creates a catalog row itself. */
export function LookupCard({ isbn, lookup, onUse }: LookupCardProps) {
  const imprint = [lookup.publisher, lookup.publishedYear?.toString()]
    .filter((part) => part !== undefined)
    .join(' · ')
  const source = lookup.source === undefined ? 'зовнішньому каталозі' : SOURCE_LABELS[lookup.source]

  return (
    <li className="book lookup-card">
      {lookup.coverUrl !== undefined && (
        <Image
          className="lookup-card__cover"
          src={lookup.coverUrl}
          alt={`Обкладинка «${lookup.title}»`}
          width={72}
          height={108}
        />
      )}

      <div className="lookup-card__content">
        <span className="book__meta">Знайдено за ISBN у {source}</span>
        <span className="book__title">{lookup.title}</span>
        {lookup.authors !== undefined && <span>{lookup.authors.join(', ')}</span>}
        {imprint !== '' && <span className="book__meta">{imprint}</span>}
        {isbn !== undefined && <span className="book__meta">ISBN {isbn}</span>}
        {lookup.pageCount !== undefined && (
          <span className="book__meta">{lookup.pageCount} стор.</span>
        )}

        {onUse !== undefined && (
          <button type="button" onClick={onUse}>
            Додати цю книжку
          </button>
        )}
      </div>
    </li>
  )
}
