'use client'

import Link, { useLinkStatus } from 'next/link'
import { useEffect, useId, useState } from 'react'
import {
  ArrowDownLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  UserRoundIcon,
} from 'lucide-react'
import { getInitials } from '@/components/Friends/UserAvatar'
import { ShelfCover } from '@/components/ShelfCover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { GUEST_NAME, rowAccessibleName, type LoanRowView } from '../model/loan-row'

/** How many placeholder rows stand in for the list while it loads. */
const PLACEHOLDER_ROWS = 3

export function LoanRowList({ rows }: { rows: readonly LoanRowView[] }) {
  const [areTipsHidden, setTipsHidden] = useTipsDismissal()

  return (
    <ul
      className="loan-rows"
      data-tips-hidden={areTipsHidden || undefined}
      onMouseLeave={() => {
        setTipsHidden(false)
      }}
      onFocus={() => {
        setTipsHidden(false)
      }}
    >
      {rows.map((row) => (
        <li key={row.key}>
          <LoanRow row={row} />
        </li>
      ))}
    </ul>
  )
}

/**
 * WCAG 1.4.13: a status tooltip shown by hover or focus is dismissed by Escape without moving either.
 * It stays hidden until the pointer leaves the list or the focus moves to another row.
 */
function useTipsDismissal() {
  const [areTipsHidden, setTipsHidden] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTipsHidden(true)
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return [areTipsHidden, setTipsHidden] as const
}

/**
 * One loan, drawn from the canvas «LoanRow». The whole row is one link — to the loan's page, where
 * its actions are, or for a guest record to its copy's history; «Переглянути» is part of that link,
 * not a second control, so nothing interactive is nested.
 */
function LoanRow({ row }: { row: LoanRowView }) {
  const tipId = useId()

  return (
    <Link
      className="loan-row"
      href={row.href}
      aria-label={rowAccessibleName(row)}
      aria-describedby={tipId}
    >
      <span className="loan-row__cover">
        <ShelfCover
          bookId={row.bookId}
          url={row.coverUrl}
          title={row.title}
          authors={row.authors}
        />
      </span>
      <span className="loan-row__book">
        <span className="loan-row__title">{row.title}</span>
        {row.authors !== '' && <span className="loan-row__authors">{row.authors}</span>}
        {row.edition !== '' && <span className="loan-row__edition">{row.edition}</span>}
      </span>
      <span className="loan-row__person">
        <PersonAvatar person={row.person} />
        <span className="loan-row__who">
          <span className="loan-row__name">{row.person.name ?? GUEST_NAME}</span>
          <span className="loan-row__relation">
            {row.direction === 'out' ? (
              <ArrowUpRightIcon aria-hidden="true" />
            ) : (
              <ArrowDownLeftIcon aria-hidden="true" />
            )}
            {row.relation}
          </span>
        </span>
      </span>
      <span className="loan-row__state">
        {/* The canvas's tooltip: over the badge after a pause, or with the row's keyboard focus. It is
            text, not a control — the row stays one link — and the row reads it as its description. */}
        <span className="loan-row__badge">
          <span className={`loan-badge loan-badge--${row.badge.tone}`}>{row.badge.label}</span>
          <span role="tooltip" id={tipId} className="loan-tip">
            {row.badge.tip}
          </span>
        </span>
        {row.hint !== null && (
          <span
            className={row.hint.isAlert ? 'loan-row__hint loan-row__hint--alert' : 'loan-row__hint'}
          >
            {row.hint.text}
          </span>
        )}
        {row.dates.map((date) => (
          <span key={date} className="loan-row__date">
            <CalendarIcon aria-hidden="true" />
            {date}
          </span>
        ))}
      </span>
      <ViewHint />
    </Link>
  )
}

function PersonAvatar({ person }: { person: LoanRowView['person'] }) {
  return (
    <Avatar className="loan-row__avatar" aria-hidden="true">
      {person.avatarUrl !== null && <AvatarImage src={person.avatarUrl} alt="" />}
      {person.name === null ? (
        <AvatarFallback>
          <UserRoundIcon className="size-[18px]" />
        </AvatarFallback>
      ) : (
        <AvatarFallback variant="pastel" name={person.name}>
          {getInitials(person.name)}
        </AvatarFallback>
      )}
    </Avatar>
  )
}

/**
 * «Переглянути» and its «Відкриваємо…» while the next page is on its way — the real state of that
 * navigation (`useLinkStatus`), shown the moment the row is pressed. The words are hidden from
 * assistive technology: the link's own name already ends with what it opens.
 */
function ViewHint() {
  const { pending } = useLinkStatus()

  return (
    <span className="loan-row__view" aria-hidden="true" data-pending={pending || undefined}>
      {pending ? (
        <>
          <LoaderCircleIcon className="motion-safe:animate-spin" />
          <span className="loan-row__view-text">Відкриваємо…</span>
        </>
      ) : (
        <>
          <span className="loan-row__view-text">Переглянути</span>
          <ArrowRightIcon className="loan-row__view-arrow" />
          <ChevronRightIcon className="loan-row__view-chevron" />
        </>
      )}
    </span>
  )
}

/** The rows' places while the list loads; the text says the same to a screen reader. */
export function LoanRowsSkeleton() {
  return (
    <>
      <p className="sr-only">Завантажуємо позики…</p>
      <ul className="loan-rows" aria-hidden="true">
        {Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => (
          <li key={index} className="loan-row loan-row--placeholder">
            <Skeleton className="loan-row__cover" />
            <span className="loan-row__book">
              <Skeleton className="h-[18px] w-[70%]" />
              <Skeleton className="h-3.5 w-1/2" />
            </span>
            <span className="loan-row__person">
              <Skeleton className="loan-row__avatar rounded-full" />
              <Skeleton className="h-3.5 w-3/5" />
            </span>
            <span className="loan-row__state">
              <Skeleton className="h-[26px] w-[110px]" />
              <Skeleton className="h-3 w-3/4" />
            </span>
            <Skeleton className="loan-row__view loan-row__view--placeholder" />
          </li>
        ))}
      </ul>
    </>
  )
}
