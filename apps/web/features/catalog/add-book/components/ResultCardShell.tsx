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

type ResultCardShellBadgeProps =
  { showBadge: true; badge: string } | { showBadge?: false; badge?: string }

type ResultCardShellProps = ResultCardShellBaseProps & ResultCardShellBadgeProps

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
