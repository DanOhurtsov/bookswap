'use client'

import Link from 'next/link'
import { useEffect, useRef, type ReactNode } from 'react'
import type { FriendRequest } from '@bookswap/shared'
import { CheckIcon, LoaderCircleIcon } from 'lucide-react'
import { formatDate } from '@/app/lib/labels'
import { personHref } from '@/app/lib/person-href'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import type { IncomingRow } from '@/components/Friends/friends-view'

type RequestRowFrameProps = { request: FriendRequest; meta: string; children: ReactNode }

/** Avatar, «Ім’я @нік» and one line about the request; the row's controls go on the right. */
function RequestRowFrame({ request, meta, children }: RequestRowFrameProps) {
  return (
    <li className="request-row">
      <UserAvatar user={request.user} variant="pastel" className="request-row__avatar" />
      <div className="request-row__who">
        <p className="request-row__name">
          {request.user.displayName}{' '}
          <span className="request-row__handle">@{request.user.handle}</span>
        </p>
        <p className="request-row__meta">{meta}</p>
      </div>
      <div className="request-row__actions">{children}</div>
    </li>
  )
}

function Spinner() {
  return <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
}

type IncomingRequestRowProps = {
  row: IncomingRow
  busyKey: string | undefined
  onAccept: () => void
  onDecline: () => void
}

/** «Хочуть додати вас»: «Відхилити» and «Прийняти», then the outcome in the same place. */
function IncomingRequestRow({ row, busyKey, onAccept, onDecline }: IncomingRequestRowProps) {
  const { request } = row
  const name = request.user.displayName
  const meta = `Хоче додати вас у друзі · ${formatDate(request.createdAt)}`

  if (row.kind === 'answered') {
    return (
      <RequestRowFrame request={request} meta={meta}>
        <RequestOutcome request={request} accepted={row.outcome === 'accepted'} />
      </RequestRowFrame>
    )
  }

  const busy = busyKey !== undefined
  const accepting = busyKey === `accept:${request.id}`
  const declining = busyKey === `decline:${request.id}`

  return (
    <RequestRowFrame request={request} meta={meta}>
      <button
        type="button"
        className="friends-button friends-button--secondary"
        disabled={busy}
        aria-busy={declining || undefined}
        aria-label={`Відхилити запит від ${name}`}
        onClick={onDecline}
      >
        {declining && <Spinner />}
        Відхилити
      </button>
      <button
        type="button"
        className="friends-button friends-button--primary"
        disabled={busy}
        aria-busy={accepting || undefined}
        aria-label={`Прийняти запит від ${name}`}
        onClick={onAccept}
      >
        {accepting && <Spinner />}
        Прийняти
      </button>
    </RequestRowFrame>
  )
}

/**
 * The answer in place of the buttons. The button that was pressed is gone, so the focus would fall
 * to the page; the outcome takes it — but only then, not when the tab is opened again later.
 */
function RequestOutcome({ request, accepted }: { request: FriendRequest; accepted: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) {
      ref.current?.focus()
    }
  }, [])

  return (
    <>
      <p
        ref={ref}
        tabIndex={-1}
        role="status"
        className={
          accepted ? 'request-row__outcome request-row__outcome--ok' : 'request-row__outcome'
        }
      >
        {accepted && <CheckIcon aria-hidden="true" />}
        {accepted ? 'Тепер ви друзі' : 'Запит відхилено'}
      </p>
      {accepted && (
        <Link
          href={personHref(request.user)}
          className="friends-button friends-button--secondary"
          aria-label={`Бібліотека: ${request.user.displayName}`}
        >
          Бібліотека
        </Link>
      )}
    </>
  )
}

type OutgoingRequestRowProps = {
  request: FriendRequest
  busyKey: string | undefined
  onCancel: () => void
}

/** «Ви надіслали»: the request waits; «Скасувати запит» asks first (`confirmCancelRequest`). */
function OutgoingRequestRow({ request, busyKey, onCancel }: OutgoingRequestRowProps) {
  const cancelling = busyKey === `remove:${request.user.id}`

  return (
    <RequestRowFrame
      request={request}
      meta={`Надіслано ${formatDate(request.createdAt)} · чекає відповіді`}
    >
      <button
        type="button"
        className="friends-button friends-button--secondary"
        disabled={busyKey !== undefined}
        aria-busy={cancelling || undefined}
        aria-label={`Скасувати запит до ${request.user.displayName}`}
        onClick={onCancel}
      >
        {cancelling && <Spinner />}
        Скасувати запит
      </button>
    </RequestRowFrame>
  )
}

export { IncomingRequestRow, OutgoingRequestRow }
