import type { ReactNode } from 'react'
import { BookCover } from '@/components/BookCover'
import { cn } from '@/lib/utils'

type ResultCardShellBaseProps = {
  title: ReactNode
  coverUrl?: string | undefined
  coverAlt: string
  authors?: ReactNode
  meta?: (string | undefined)[]
  children?: ReactNode
  /**
   * The add search (BS-114): the title becomes the card's one button, stretched over the whole card, so
   * the cover and the title choose the result while nothing interactive is nested in anything else.
   */
  onSelect?: (trigger: HTMLButtonElement) => void
}

type ResultCardShellBadgeProps =
  { showBadge: true; badge: string } | { showBadge?: false; badge?: string }

type ResultCardShellProps = ResultCardShellBaseProps & ResultCardShellBadgeProps

export function ResultCardShell(props: ResultCardShellProps) {
  const { title, coverUrl, coverAlt, authors, meta, children, onSelect } = props
  const facts = (meta ?? []).filter((part): part is string => part !== undefined && part !== '')

  return (
    <li
      data-slot="result-card"
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] gap-[0.85rem] rounded-md border border-(--line) px-4 py-[0.9rem]',
        onSelect !== undefined && 'relative hover:border-(--bookswap-muted)',
      )}
    >
      <BookCover url={coverUrl} alt={coverAlt} />

      <div className="grid min-w-0 content-start justify-items-start gap-1">
        {props.showBadge === true && (
          <span className="rounded-[1rem] border border-(--line) px-2 py-[0.05rem] text-[0.8rem] text-(--bookswap-muted)">
            {props.badge}
          </span>
        )}
        {onSelect === undefined ? (
          title
        ) : (
          <button
            type="button"
            // Opt out of the global `button:not([data-ui='button'])` rule in globals.css: this reads as a title.
            data-ui="button"
            className="max-w-full cursor-pointer rounded-sm text-left wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bookswap-accent) after:absolute after:inset-0 after:rounded-md after:content-['']"
            onClick={(event) => {
              onSelect(event.currentTarget)
            }}
          >
            {title}
          </button>
        )}
        {authors}
        {facts.length > 0 && (
          <span className="text-[0.85rem] text-(--bookswap-muted)">{facts.join(' · ')}</span>
        )}
        {children}
      </div>
    </li>
  )
}
