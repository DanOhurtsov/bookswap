import type { ReactNode } from 'react'
import { BookCover } from '@/components/BookCover'

type ResultCardShellBaseProps = {
  title: ReactNode
  coverUrl?: string | undefined
  coverAlt: string
  authors?: ReactNode
  meta?: (string | undefined)[]
  children?: ReactNode
}

/** Бейдж показується лише з `showBadge`, а з `showBadge` без тексту бейджа він не має сенсу. */
type ResultCardShellBadgeProps =
  { showBadge: true; badge: string } | { showBadge?: false; badge?: string }

type ResultCardShellProps = ResultCardShellBaseProps & ResultCardShellBadgeProps

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
export function ResultCardShell(props: ResultCardShellProps) {
  const { title, coverUrl, coverAlt, authors, meta, children } = props
  const facts = (meta ?? []).filter((part): part is string => part !== undefined && part !== '')

  return (
    <li
      data-slot="result-card"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-[0.85rem] rounded-md border border-(--line) px-4 py-[0.9rem]"
    >
      <BookCover url={coverUrl} alt={coverAlt} />

      <div className="grid min-w-0 content-start justify-items-start gap-1">
        {props.showBadge === true && (
          <span className="rounded-[1rem] border border-(--line) px-2 py-[0.05rem] text-[0.8rem] text-(--bookswap-muted)">
            {props.badge}
          </span>
        )}
        {title}
        {authors}
        {facts.length > 0 && (
          <span className="text-[0.85rem] text-(--bookswap-muted)">{facts.join(' · ')}</span>
        )}
        {children}
      </div>
    </li>
  )
}
