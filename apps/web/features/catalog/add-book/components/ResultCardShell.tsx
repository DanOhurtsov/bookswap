import { PlusIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { BookCover } from '@/components/BookCover'
import { cn } from '@/lib/utils'

type ResultCardGridProps = {
  /** `ResultCardShell` items. */
  children: ReactNode
}

/**
 * The one geometry of search results on `/catalog` and `/catalog/new` (BS-134): 1–4 columns by the
 * width of the list itself — `.result-grid` in `globals.css` owns the thresholds.
 */
export function ResultCardGrid({ children }: ResultCardGridProps) {
  return (
    <div className="result-grid">
      <ul>{children}</ul>
    </div>
  )
}

type ResultCardShellBaseProps = {
  title: ReactNode
  coverUrl?: string | undefined
  coverAlt: string
  authors?: ReactNode
  meta?: (string | undefined)[]
  children?: ReactNode
}

type ResultCardShellSelectProps =
  | {
      /**
       * The add search (BS-114): the title becomes a button stretched over the whole card, so the cover
       * and the title choose the result, and «+» at the bottom of the card chooses it too. Both open the
       * dialog and get `trigger` back for the focus; neither adds anything by itself.
       */
      onSelect: (trigger: HTMLButtonElement) => void
      /** The book's title as text — the accessible name of «+». */
      selectTitle: string
      /** The card's short add state («Додаю…», «✓ У моїй бібліотеці»), beside «+». */
      status?: ReactNode
    }
  | { onSelect?: undefined; selectTitle?: undefined; status?: undefined }

type ResultCardShellBadgeProps =
  { showBadge: true; badge: string } | { showBadge?: false; badge?: string }

type ResultCardShellProps = ResultCardShellBaseProps &
  ResultCardShellSelectProps &
  ResultCardShellBadgeProps

/**
 * One vertical result card: the cover on top, then the text, then — on the add search — the status and
 * «+» pinned to the bottom, so «+» is in the same place on every card of a grid row (the grid stretches
 * the cards of a row to one height).
 */
export function ResultCardShell(props: ResultCardShellProps) {
  const { title, coverUrl, coverAlt, authors, meta, children, onSelect } = props
  const facts = (meta ?? []).filter((part): part is string => part !== undefined && part !== '')

  return (
    <li
      data-slot="result-card"
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-md border border-(--line) px-4 py-[0.9rem]',
        onSelect !== undefined && 'relative hover:border-(--bookswap-muted)',
      )}
    >
      <div className="flex justify-center">
        <BookCover url={coverUrl} alt={coverAlt} variant="card" />
      </div>

      {/* In a grid column a title, an author or an ISBN with no spaces must break, not widen the card. */}
      <div className="grid min-w-0 content-start justify-items-start gap-1 wrap-anywhere">
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
            aria-haspopup="dialog"
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

      {onSelect !== undefined && (
        <div className="mt-auto flex items-end justify-between gap-2 wrap-anywhere">
          <div className="min-w-0">{props.status}</div>
          <button
            type="button"
            data-ui="button"
            aria-haspopup="dialog"
            aria-label={`Додати «${props.selectTitle}»`}
            // Above the title's stretched `::after`: «+» is its own target, never covered by the card's.
            className="relative z-10 grid size-11 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent bg-(--fg) text-(--bg) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bookswap-accent)"
            onClick={(event) => {
              onSelect(event.currentTarget)
            }}
          >
            <PlusIcon aria-hidden="true" className="size-5" />
          </button>
        </div>
      )}
    </li>
  )
}
