import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import type { BorrowedLibraryGroup, LibraryGroup } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { cn } from '@/lib/utils'
import type { ResourceState } from '@/app/lib/use-resource'
import type { LibraryView } from '@/app/lib/use-library'
import { emptyMessage } from '../model/copy-rules'

type ShelfContentProps<TGroup extends { edition: { id: string } }> = {
  state: ResourceState<{ groups: readonly TGroup[] }>
  view: LibraryView
  renderGroup: (group: TGroup) => ReactNode
}

/** The three states every shelf has to show — loading, error, empty — and the list of groups. */
export function ShelfContent<TGroup extends { edition: { id: string } }>({
  state,
  view,
  renderGroup,
}: ShelfContentProps<TGroup>) {
  return (
    <>
      {state.status === 'loading' && <p className="status status--pending">Завантажую полицю…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.groups.length === 0 && (
        <p className="empty">{emptyMessage(view)}</p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.groups.map((group) => (
            <Fragment key={group.edition.id}>{renderGroup(group)}</Fragment>
          ))}
        </ul>
      )}
    </>
  )
}

type GroupHeaderProps = {
  group: LibraryGroup | BorrowedLibraryGroup
  href: string
  stretchedLink: boolean
  cornerMenu: boolean
}

function GroupHeader({ group, href, stretchedLink, cornerMenu }: GroupHeaderProps) {
  return (
    <HeaderLines cornerMenu={cornerMenu}>
      <Link
        className={cn(
          'book__title',
          // The link's invisible layer is stretched over the whole card, so the card is the link.
          // Whatever else on the card is interactive sits above that layer (`relative z-10`). The
          // focus ring is drawn around the card, where the link now is, not around the title.
          stretchedLink &&
            'after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring',
        )}
        href={href}
      >
        {group.work.title}
        {group.counts.total > 1 && ` ×${String(group.counts.total)}`}
      </Link>
      <AuthorLine authors={group.authors} />
      <EditionLine edition={group.edition} />
      {group.counts.total > 1 && (
        <span className="book__meta">
          {group.counts.home} вдома · {group.counts.out} не вдома
        </span>
      )}
    </HeaderLines>
  )
}

/**
 * The header lines of a card. When a menu sits in the card's top-right corner they stop short of it,
 * so a long title does not run under the button. The wrapper carries the padding because the card's
 * own `padding` (legacy CSS, outside the Tailwind layers) would win over a utility on the card.
 */
function HeaderLines({ cornerMenu, children }: { cornerMenu: boolean; children: ReactNode }) {
  if (!cornerMenu) return <>{children}</>

  return <div className="grid gap-1 pr-10">{children}</div>
}

type GroupCardProps = {
  group: LibraryGroup | BorrowedLibraryGroup
  /** Where the title, and with `stretchedLink` the whole card, leads. */
  href: string
  stretchedLink?: boolean
  /** A menu sits in the card's top-right corner: the header keeps clear of it. */
  cornerMenu?: boolean
  children: ReactNode
}

/**
 * An edition on the shelf: its header, and under it the copies the caller renders. Copies are
 * grouped by edition but each stays its own row: the number is a `COUNT` of copies, not a "how
 * many" field (§3), so each can be edited and deleted on its own.
 */
export function GroupCard({
  group,
  href,
  stretchedLink = false,
  cornerMenu = false,
  children,
}: GroupCardProps) {
  return (
    <li className={cn('book', stretchedLink && 'relative transition-colors hover:bg-muted/50')}>
      <GroupHeader
        group={group}
        href={href}
        stretchedLink={stretchedLink}
        cornerMenu={cornerMenu}
      />
      <ul className="copies">{children}</ul>
    </li>
  )
}

/** The way into one copy's own page, for a card that holds several (the card leads to the first). */
export function CopyOpenLink({ href }: { href: string }) {
  return (
    <Link className="relative z-10" href={href}>
      Відкрити
    </Link>
  )
}

export function CopyHistoryLink({ copyId }: { copyId: string }) {
  return (
    <Link className="relative z-10" href={`/copies/${copyId}/history`}>
      Історія
    </Link>
  )
}

export function CopyNote({ note }: { note: string | null }) {
  if (note === null) return null

  return <span className="book__meta">Нотатка: {note}</span>
}
