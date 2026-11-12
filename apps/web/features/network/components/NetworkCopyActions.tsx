'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { NetworkCopy, NetworkOwner } from '@bookswap/shared'
import { COPY_STATUS_LABELS, formatDate } from '@/app/lib/labels'
import { BorrowRequestForm, type ClosedBorrowPhase } from '@/features/loans/index.client'

/** How a request was settled: sent, or refused by one of the 409s. */
export type RequestOutcome = ClosedBorrowPhase['kind']

/** What a request needs from the list around the copy. */
interface RequestProps {
  /** The book, named in the phone's sheet: the list it was asked from is hidden under it. */
  bookTitle: string
  /** Reads the surrounding data again once a request is settled, told how it was. */
  onRequested: (outcome: RequestOutcome) => void | Promise<void>
  /**
   * The outcome of a settled request was closed — by «Закрити», or in the phone's sheet by Escape or
   * its ✕. For a list that reads itself again only then; «Скасувати» on a draft is not an outcome.
   */
  onOutcomeClosed?: (outcome: RequestOutcome) => void
}

interface CopyProps extends RequestProps {
  copy: NetworkCopy
  ownerName: string
  relation: NetworkOwner['relation']
}

/**
 * One visible copy: its status, the expected return date, and the request action — the same
 * «Попросити книжку» form as on a friend's shelf (`BorrowRequestForm`), under the copy or, on a phone,
 * in a sheet over the list.
 */
export function NetworkCopyActions({
  copy,
  ownerName,
  relation,
  bookTitle,
  onRequested,
  onOutcomeClosed,
}: CopyProps) {
  const [open, setOpen] = useState(false)
  const [settled, setSettled] = useState<RequestOutcome>()
  // The server has just said this copy cannot be asked for: newer than the list it was asked from, so
  // «Попросити» does not come back over that list. The list read again decides from then on.
  const [refusedOver, setRefusedOver] = useState<NetworkCopy>()
  const canRequest = copy.canRequest && refusedOver !== copy
  const requestButton = useRef<HTMLButtonElement>(null)
  const statusLine = useRef<HTMLSpanElement>(null)

  // The form takes the focus with it: back to «Попросити», or — once the re-read copy can no longer be
  // asked for — to the copy's own line, never to the top of the page.
  const close = () => {
    flushSync(() => {
      setOpen(false)
      setSettled(undefined)
    })
    ;(requestButton.current ?? statusLine.current)?.focus()
    if (settled !== undefined) onOutcomeClosed?.(settled)
  }

  return (
    <li className="copy">
      <span ref={statusLine} tabIndex={-1} className="book__meta">
        {COPY_STATUS_LABELS[copy.status]}
        {copy.expectedReturnAt !== null &&
          ` · орієнтовно вільна ${formatDate(copy.expectedReturnAt)}`}
      </span>{' '}
      {/* An open form stays until it is closed: its outcome outlives the re-read list, where the copy
          it has just been asked for is no longer `canRequest`. The list carries no loan of the viewer's
          own, so a duplicate request has no link to open — `myLoanId` is unknown here, not absent. */}
      {open ? (
        <BorrowRequestForm
          copyId={copy.id}
          bookTitle={bookTitle}
          ownerName={ownerName}
          myLoanId={null}
          expectedReturnAt={copy.expectedReturnAt}
          onSettled={(outcome) => {
            setSettled(outcome.kind)
            if (outcome.kind === 'unavailable') setRefusedOver(copy)

            return onRequested(outcome.kind)
          }}
          onClose={close}
        />
      ) : canRequest ? (
        <button
          ref={requestButton}
          type="button"
          onClick={() => {
            setOpen(true)
          }}
        >
          Попросити
        </button>
      ) : relation === 'OTHER' ? (
        <span className="book__meta">
          <Link href="/friends">Спочатку додайте власника в друзі</Link>
        </span>
      ) : relation === 'SELF' ? (
        <span className="book__meta">Ваш примірник.</span>
      ) : (
        <span className="book__meta">Зараз попросити не можна.</span>
      )}
    </li>
  )
}

/** All of one owner's visible copies. */
export function NetworkOwnerCopies({
  owner,
  bookTitle,
  onRequested,
  onOutcomeClosed,
}: { owner: NetworkOwner } & RequestProps) {
  return (
    <ul className="copies">
      {owner.copies.map((copy) => (
        <NetworkCopyActions
          key={copy.id}
          copy={copy}
          ownerName={owner.owner.displayName}
          relation={owner.relation}
          bookTitle={bookTitle}
          onRequested={onRequested}
          onOutcomeClosed={onOutcomeClosed}
        />
      ))}
    </ul>
  )
}
