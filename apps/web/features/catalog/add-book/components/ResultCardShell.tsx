import type { ReactNode } from 'react'
import { BookCover } from '@/components/BookCover'

type ResultCardShellProps = {
  /** Where this record came from: «Наш каталог», «Open Library», «Google Books». */
  badge: string
  title: ReactNode
  coverUrl?: string | undefined
  coverAlt: string
  authors?: ReactNode
  /** Short facts under the title — language, year. Empty entries are dropped. */
  meta?: (string | undefined)[]
  children?: ReactNode
}

/**
 * The shared look of one row in the search results.
 *
 * Local and external candidates render through the same shell on purpose. They
 * are shown in ONE list, and a list whose rows are built differently reads as
 * two lists that happen to be adjacent — the person then has to work out which
 * comparison is even valid. Cover, title, authors and the short meta line
 * therefore sit in the same places regardless of origin; only the actions below
 * differ, because only the actions really do.
 *
 * Empty fields are omitted rather than filled with a dash or "unknown" (§6.3
 * item 7). A source that said nothing about the year leaves no line.
 *
 * The cover is the one exception, and deliberately so: `BookCover` always
 * renders a box, a picture or a placeholder. An omitted cover would collapse
 * the first grid column and re-align every other row in the list around
 * whichever sources happened to know a cover URL.
 */
export function ResultCardShell({
  badge,
  title,
  coverUrl,
  coverAlt,
  authors,
  meta,
  children,
}: ResultCardShellProps) {
  const facts = (meta ?? []).filter((part): part is string => part !== undefined && part !== '')

  return (
    <li className="book lookup-card">
      <BookCover url={coverUrl} alt={coverAlt} />

      <div className="lookup-card__content">
        <span className="chip">{badge}</span>
        {title}
        {authors}
        {facts.length > 0 && <span className="book__meta">{facts.join(' · ')}</span>}
        {children}
      </div>
    </li>
  )
}
