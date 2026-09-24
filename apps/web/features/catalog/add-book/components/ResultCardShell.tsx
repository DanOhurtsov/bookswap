import Image from 'next/image'
import type { ReactNode } from 'react'

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
 * `unoptimized` on every cover, not just the external ones: `next/image` throws
 * on a host absent from `images.remotePatterns` (`next.config.ts`), and one
 * such cover anywhere in this list would take the whole list down with it.
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
      {coverUrl !== undefined && (
        <Image
          className="lookup-card__cover"
          src={coverUrl}
          alt={coverAlt}
          width={72}
          height={108}
          unoptimized
        />
      )}

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
