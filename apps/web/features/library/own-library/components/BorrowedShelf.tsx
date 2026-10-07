'use client'

import Link from 'next/link'
import type { BorrowedLibraryGroup } from '@bookswap/shared'
import { CONDITION_LABELS } from '@/app/lib/labels'
import { useBorrowedLibrary } from '@/app/lib/use-library'
import { CopyHistoryLink, GroupCard, ShelfContent } from './ShelfParts'

/** Other people's copies that are with me now. Read-only: there is nothing to change on them. */
export function BorrowedShelf() {
  const { state } = useBorrowedLibrary()

  return (
    <ShelfContent
      state={state}
      view="borrowed"
      renderGroup={(group) => <BorrowedGroupCard group={group} />}
    />
  )
}

function BorrowedGroupCard({ group }: { group: BorrowedLibraryGroup }) {
  return (
    <GroupCard group={group} href={`/works/${group.work.id}`}>
      {group.copies.map((copy) => (
        <li className="copy" key={copy.id}>
          <span className="book__meta">
            {CONDITION_LABELS[copy.condition]} · власник: {copy.owner.displayName}
          </span>
          <span className="book__meta">
            {/* The loan id is explicit: it is the loan this book arrived here by, not "some
                active one". "Where is my copy" and "who is asking for it" have different answers
                (§5.2, §5.3.1). */}
            {copy.activeLoan !== null && (
              <Link href={`/loans?loanId=${copy.activeLoan.id}&role=borrower`}>Моє позичання</Link>
            )}
            {copy.activeLoan !== null && ' · '}
            <CopyHistoryLink copyId={copy.id} />
          </span>
        </li>
      ))}
    </GroupCard>
  )
}
