'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import type { VisibleCopy, VisibleLibraryGroup } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { CONDITION_LABELS, COPY_STATUS_LABELS, formatDate } from '@/app/lib/labels'
import { borrowerLoanHref } from '@/features/loans'
import { BorrowRequestForm } from '@/features/loans/index.client'
import { useFriendShelf } from '../model/use-friend-shelf'

export function PersonShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {children}
    </main>
  )
}

/**
 * §6.5: another person's library. Mounted below `PersonGate`, which has already found the owner.
 *
 * The page hides nothing by itself — it shows exactly what arrived. What is visible is decided by
 * the API under the §9 matrix, and private fields are simply absent from the answer. Filtering them
 * here would be a second implementation of the same rules, bound to drift from the first one day.
 *
 * The «Попросити» button (§5.1) looks at `myActiveLoan`, NOT at `Copy.status`: a request does not
 * change the copy, so after a sent request the book stays `AVAILABLE`. Deciding by status would allow
 * a second click and a 409 — an error the client should have known in advance.
 */
export function PersonLibrary({ ownerId }: { ownerId: string }) {
  const { state, shelf, backgroundErrorMessage, reload } = useFriendShelf(ownerId)

  if (shelf === undefined && state.status === 'error') {
    return (
      <PersonShell title="Бібліотека">
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <Link href="/friends">До друзів</Link>
        </p>
      </PersonShell>
    )
  }

  if (shelf === undefined) {
    return (
      <PersonShell title="Бібліотека">
        <p className="status status--pending">Завантажую…</p>
      </PersonShell>
    )
  }

  return (
    <PersonShell title={`Бібліотека: ${shelf.owner.displayName}`}>
      {backgroundErrorMessage !== undefined && (
        <FormStatus error={new Error(backgroundErrorMessage)} />
      )}
      {shelf.groups.length === 0 ? (
        <p className="empty">Тут поки нічого не видно.</p>
      ) : (
        <ul className="books">
          {shelf.groups.map((group) => (
            <GroupCard
              key={group.edition.id}
              group={group}
              ownerName={shelf.owner.displayName}
              onRequested={reload}
            />
          ))}
        </ul>
      )}
    </PersonShell>
  )
}

type RequestProps = {
  ownerName: string
  /** Reads the shelf again once a request is settled. */
  onRequested: () => Promise<void>
}

function GroupCard({
  group,
  ownerName,
  onRequested,
}: { group: VisibleLibraryGroup } & RequestProps) {
  return (
    <li className="book">
      <Link className="book__title" href={`/works/${group.work.id}`}>
        {group.work.title}
        {group.counts.total > 1 && ` ×${String(group.counts.total)}`}
      </Link>
      {/* §6.5: the wishlist mark is only a flag, with no actions here. Adding or removing happens
          on the work's page (`WishlistButton`), which also has the `authors` an optimistic add needs. */}
      {group.inWishlist && <span className="badge">У вішлисті</span>}
      <AuthorLine authors={group.authors} />
      <EditionLine edition={group.edition} />

      <ul className="copies">
        {group.copies.map((copy) => (
          <li className="copy" key={copy.id}>
            <span className="book__meta">
              {COPY_STATUS_LABELS[copy.status]} · {CONDITION_LABELS[copy.condition]}
              {/* §6.6: the holder's name shows only when the owner allowed it; otherwise it arrives
                  as null and only the status is visible. */}
              {!copy.isHome &&
                (copy.holder === null ? ' · зараз у когось' : ` · у ${copy.holder.displayName}`)}
              {/* §6.5: «for RESERVED / LENT_OUT — the expected return date, if the owner set one».
                  The date is a separate field, independent of showHolderNames: it is about the book,
                  not about the person. */}
              {copy.expectedReturnAt !== null &&
                ` · орієнтовно вільна ${formatDate(copy.expectedReturnAt)}`}
            </span>

            <CopyAction
              copy={copy}
              bookTitle={group.work.title}
              ownerName={ownerName}
              onRequested={onRequested}
            />
          </li>
        ))}
      </ul>
    </li>
  )
}

/**
 * What can be done with this copy right now.
 *
 * The order of the branches matters: **the viewer's own loan first**, the copy's status only after.
 * The reverse order is exactly the mistake `myActiveLoan` prevents: after a sent request the book is
 * still `AVAILABLE`, and «Попросити» would appear a second time.
 */
function CopyAction({
  copy,
  bookTitle,
  ownerName,
  onRequested,
}: { copy: VisibleCopy; bookTitle: string } & RequestProps) {
  const [open, setOpen] = useState(false)

  // An open form stays until it is closed: its outcome outlives the re-read shelf, where the request
  // it has just made is already the copy's `myActiveLoan`.
  if (open) {
    return (
      <BorrowRequestForm
        copyId={copy.id}
        bookTitle={bookTitle}
        ownerName={ownerName}
        myLoanId={copy.myActiveLoan?.id ?? null}
        expectedReturnAt={copy.expectedReturnAt}
        onSettled={onRequested}
        onClose={() => {
          setOpen(false)
        }}
      />
    )
  }

  if (copy.myActiveLoan !== null) {
    // The deep link leads to THIS loan, not to a list it still has to be found in. `role=borrower` is
    // the viewer's side: on someone else's shelf the viewer is always the one asking.
    const loanHref = borrowerLoanHref(copy.myActiveLoan.id)

    switch (copy.myActiveLoan.status) {
      case 'REQUESTED':
        return (
          <span className="book__meta">
            Запит надіслано — чекайте на відповідь. <Link href={loanHref}>Відкрити запит</Link>
          </span>
        )
      case 'APPROVED':
        return (
          <span className="book__meta">
            Домовлено. Коли отримаєте книжку — підтвердьте це в{' '}
            <Link href={loanHref}>позичанні</Link>.
          </span>
        )
      case 'PENDING_CONFIRMATION':
        return (
          <span className="book__meta">
            Власник записав, що передав вам цю книжку. Підтвердьте отримання або відхиліть запис у{' '}
            <Link href={loanHref}>позиченні</Link>.
          </span>
        )
      case 'HANDED_OVER':
        return (
          <span className="book__meta">
            Ця книжка зараз у вас. <Link href={loanHref}>Відкрити позичання</Link> ·{' '}
            <Link href="/library">Чужі в мене</Link>
          </span>
        )
    }
  }

  // §6.5 and §9: the capability is computed by the server. There is deliberately NO check of status,
  // friendship or visibility here — those would be second implementations of the authorization
  // rules, and without the data needed to answer correctly.
  //
  // The return date is not repeated here: it is already in the status line above.
  if (!copy.canRequest) {
    return <span className="book__meta">Зараз попросити не можна.</span>
  }

  return (
    <div className="person__actions">
      <button
        type="button"
        onClick={() => {
          setOpen(true)
        }}
      >
        Попросити
      </button>
    </div>
  )
}
