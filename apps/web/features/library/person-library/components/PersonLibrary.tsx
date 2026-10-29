'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import type { VisibleCopy, VisibleLibraryGroup } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { RequestCopyForm } from '@/components/RequestCopyForm'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { CONDITION_LABELS, COPY_STATUS_LABELS, formatDate } from '@/app/lib/labels'
import { useFriendLibrary } from '@/app/lib/use-library'

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
  const { state, reload } = useFriendLibrary(ownerId)
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()

  async function requestCopy(copyId: string, body: Record<string, unknown>): Promise<void> {
    setFailure(undefined)
    setBusyKey(`request:${copyId}`)

    try {
      await apiRequest('/loans', { method: 'POST', body: { copyId, ...body } })
      // `await`: until the refreshed list with `canRequest: false` arrives, the button stays
      // disabled — otherwise a second click would get a 409.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
    }
  }

  if (state.status === 'loading') {
    return (
      <PersonShell title="Бібліотека">
        <p className="status status--pending">Завантажую…</p>
      </PersonShell>
    )
  }

  if (state.status === 'error') {
    return (
      <PersonShell title="Бібліотека">
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <Link href="/friends">До друзів</Link>
        </p>
      </PersonShell>
    )
  }

  return (
    <PersonShell title={`Бібліотека: ${state.data.owner.displayName}`}>
      <FormStatus error={failure} />

      {state.data.groups.length === 0 ? (
        <p className="empty">Тут поки нічого не видно.</p>
      ) : (
        <ul className="books">
          {state.data.groups.map((group) => (
            <GroupCard
              key={group.edition.id}
              group={group}
              busyKey={busyKey}
              onRequest={requestCopy}
            />
          ))}
        </ul>
      )}
    </PersonShell>
  )
}

function GroupCard({
  group,
  busyKey,
  onRequest,
}: {
  group: VisibleLibraryGroup
  busyKey: string | undefined
  onRequest: (copyId: string, body: Record<string, unknown>) => Promise<void>
}) {
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

            <CopyAction copy={copy} busyKey={busyKey} onRequest={onRequest} />
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
  busyKey,
  onRequest,
}: {
  copy: VisibleCopy
  busyKey: string | undefined
  onRequest: (copyId: string, body: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const busy = busyKey !== undefined

  if (copy.myActiveLoan !== null) {
    // The deep link leads to THIS loan, not to a list it still has to be found in. `role=borrower` is
    // the viewer's side: on someone else's shelf the viewer is always the one asking.
    const loanHref = `/loans?loanId=${copy.myActiveLoan.id}&role=borrower`

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

  if (!open) {
    return (
      <div className="person__actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(true)
          }}
        >
          Попросити
        </button>
      </div>
    )
  }

  return (
    <RequestCopyForm
      copyId={copy.id}
      busy={busy}
      submitting={busyKey === `request:${copy.id}`}
      onSubmit={(body) => {
        void onRequest(copy.id, body)
      }}
      onCancel={() => {
        setOpen(false)
      }}
    />
  )
}
