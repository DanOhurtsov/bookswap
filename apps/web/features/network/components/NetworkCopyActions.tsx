'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { NetworkCopy, NetworkOwner } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { COPY_STATUS_LABELS, formatDate } from '@/app/lib/labels'
import { FormStatus } from '@/components/Form/FormStatus'
import { RequestCopyForm } from '@/components/RequestCopyForm'
import { requestLoan } from '../api/network-requests'

interface CopyProps {
  copy: NetworkCopy
  relation: NetworkOwner['relation']
  /** Called after the request went through — refresh the surrounding data. */
  onRequested: () => void | Promise<void>
}

/** One visible copy: its status, the expected return date, and the request action. */
export function NetworkCopyActions({ copy, relation, onRequested }: CopyProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()

  async function submit(body: Record<string, unknown>): Promise<void> {
    setFailure(undefined)
    setBusy(true)

    try {
      await requestLoan(copy.id, body)
      // Awaited: until fresh data brings `canRequest: false`, the button must not come back.
      await onRequested()
      setOpen(false)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="copy">
      <span className="book__meta">
        {COPY_STATUS_LABELS[copy.status]}
        {copy.expectedReturnAt !== null &&
          ` · орієнтовно вільна ${formatDate(copy.expectedReturnAt)}`}
      </span>{' '}
      <FormStatus error={failure} />
      {copy.canRequest ? (
        open ? (
          <RequestCopyForm
            copyId={copy.id}
            busy={busy}
            submitting={busy}
            onSubmit={(body) => {
              void submit(body)
            }}
            onCancel={() => {
              setOpen(false)
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen(true)
            }}
          >
            Попросити
          </button>
        )
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
  onRequested,
}: {
  owner: NetworkOwner
  onRequested: () => void | Promise<void>
}) {
  return (
    <ul className="copies">
      {owner.copies.map((copy) => (
        <NetworkCopyActions
          key={copy.id}
          copy={copy}
          relation={owner.relation}
          onRequested={onRequested}
        />
      ))}
    </ul>
  )
}
