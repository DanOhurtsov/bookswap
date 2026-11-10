'use client'

import Link from 'next/link'
import { useEffect, useId, type RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { LOAN_LIMITS, type Loan, type LoanTermDays } from '@bookswap/shared'
import { getInitials } from '@/components/Friends/UserAvatar'
import { ShelfCover } from '@/components/ShelfCover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { localDay, shortDay } from '../model/loan-term'
import {
  answerFailureText,
  ownerTermHint,
  type OutcomeTone,
  type OwnerRequestOutcome,
  type OwnerRequestView as View,
} from '../model/owner-request-view'
import { useApproveForm } from '../model/use-approve-form'
import type { LoanPageActions } from '../model/use-loan-page-actions'
import { LoanTermField } from './LoanTermField'

const OUTCOME_ICONS: Readonly<Record<OutcomeTone, LucideIcon>> = {
  ok: CircleCheckIcon,
  done: CheckIcon,
  info: InfoIcon,
}

type OwnerRequestViewProps = {
  loan: Loan
  view: View
  defaultLoanTermDays: LoanTermDays | null
  actions: LoanPageActions
  /** «До позичань»: the list this page was opened from. */
  backHref: string
  onOpenLoan: () => void
  /** The outcome's title: the focus lands here once the answer's form is gone. */
  titleRef: RefObject<HTMLHeadingElement | null>
}

/**
 * The canvas's «Запит до власника»: who asks, for which book, the term and an answer — then the
 * outcome, once the loan read back from the server says it. «Погодити» and «Відмовити» are the page's
 * own actions (`useLoanPageActions`); a refusal asks first in the page's dialog.
 */
export function OwnerRequestView({
  loan,
  view,
  defaultLoanTermDays,
  actions,
  backHref,
  onOpenLoan,
  titleRef,
}: OwnerRequestViewProps) {
  const { outcome } = view

  // The pressed button is gone with the form: the outcome takes the focus it had.
  useEffect(() => {
    if (outcome === null) return
    if (document.activeElement === null || document.activeElement === document.body) {
      titleRef.current?.focus()
    }
  }, [outcome, titleRef])

  return (
    <div className="owner-request">
      <div className="owner-request__head">
        <h3 className="owner-request__title">Запит на книжку</h3>
        <span className={`loan-badge loan-badge--${view.badge.tone}`}>{view.badge.label}</span>
        {view.sentLabel !== null && <span className="owner-request__sent">{view.sentLabel}</span>}
      </div>
      <div className="owner-request__grid">
        <BorrowerCard view={view} />
        <BookCard book={view.book} />
        <div className="owner-request__answer">
          {outcome === null ? (
            <AnswerCard
              loan={loan}
              view={view}
              defaultLoanTermDays={defaultLoanTermDays}
              actions={actions}
            />
          ) : (
            <OutcomeCard
              outcome={outcome}
              backHref={backHref}
              onOpenLoan={onOpenLoan}
              titleRef={titleRef}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function BorrowerCard({ view }: { view: View }) {
  const { borrower, message } = view

  return (
    <section className="owner-request__card owner-request__who" aria-label="Хто просить">
      <div className="owner-request__person">
        <Avatar className="owner-request__avatar" aria-hidden="true">
          {borrower.avatarUrl !== null && <AvatarImage src={borrower.avatarUrl} alt="" />}
          <AvatarFallback variant="pastel" name={borrower.name}>
            {getInitials(borrower.name)}
          </AvatarFallback>
        </Avatar>
        <span className="owner-request__person-words">
          <Link className="owner-request__name" href={borrower.href}>
            {borrower.name}
          </Link>
          <span className="owner-request__handle">{borrower.handle}</span>
        </span>
      </div>
      {message !== null && (
        <div className="owner-request__message">
          <span className="owner-request__message-label">{message.label}</span>
          <blockquote className="owner-request__quote">«{message.text}»</blockquote>
        </div>
      )}
    </section>
  )
}

function BookCard({ book }: { book: View['book'] }) {
  return (
    <section className="owner-request__card owner-request__book" aria-label="Ваша книжка">
      <span className="owner-request__cover">
        <ShelfCover
          bookId={book.id}
          url={book.coverUrl}
          title={book.title}
          authors={book.authors}
        />
      </span>
      <span className="owner-request__book-words">
        <span className="owner-request__eyebrow">Ваша книжка</span>
        <Link className="owner-request__book-title" href={book.href}>
          {book.title}
        </Link>
        {book.line !== '' && <span className="owner-request__book-line">{book.line}</span>}
        <span className="owner-request__copy-state">{book.copyState}</span>
      </span>
    </section>
  )
}

type AnswerCardProps = {
  loan: Loan
  view: View
  defaultLoanTermDays: LoanTermDays | null
  actions: LoanPageActions
}

/**
 * The answer: the term, a note and the two buttons. The values live in this card's form for as long as
 * the request is open, so a failed attempt keeps them for the next one.
 */
function AnswerCard({ loan, view, defaultLoanTermDays, actions }: AnswerCardProps) {
  const form = useApproveForm(loan, defaultLoanTermDays)
  const noteId = useId()
  const countId = useId()
  const today = localDay(new Date())
  const isLocked = actions.busyKey !== undefined
  const isApproving = actions.busyKey === `approve:${loan.id}`
  const { requested } = view
  const failure = actions.confirmation === undefined ? actions.failure : undefined

  return (
    <section className="owner-request__card owner-request__form" aria-label="Відповідь на запит">
      <LoanTermField
        value={form.dueAt}
        onChange={form.setDueAt}
        today={today}
        requested={requested}
        hint={ownerTermHint(requested)}
        empty={{ title: 'Без дати', text: 'Позика буде без дати повернення.' }}
        canClear={requested === null}
        isLocked={isLocked}
      >
        {(setDay) =>
          requested !== null &&
          form.dueAt !== requested && (
            <div className="loan-term__changed">
              <span className="loan-term__changed-title">Ви змінили дату</span>
              <span className="loan-term__changed-text">У запиті — до {shortDay(requested)}.</span>
              <button
                type="button"
                className="loan-term__link"
                onClick={() => {
                  setDay(requested)
                }}
              >
                Повернути як у запиті
              </button>
            </div>
          )
        }
      </LoanTermField>

      <div className="loan-note">
        <div className="loan-note__head">
          <label htmlFor={noteId} className="loan-note__label">
            Повідомлення до погодження <span>(необовʼязково)</span>
          </label>
          <span id={countId} className="loan-note__count">
            {form.note.length}/{LOAN_LIMITS.noteMax}
          </span>
        </div>
        <textarea
          id={noteId}
          className="loan-note__field"
          aria-describedby={countId}
          maxLength={LOAN_LIMITS.noteMax}
          placeholder="Наприклад, де й коли зручно передати книжку"
          value={form.note}
          disabled={isLocked}
          onChange={(event) => {
            form.setNote(event.target.value)
          }}
        />
      </div>

      {failure !== undefined && failure !== null && (
        <div className="loan-alert" role="alert">
          <CircleAlertIcon aria-hidden="true" />
          <p>{answerFailureText(failure)}</p>
        </div>
      )}

      <div className="loan-form-actions">
        <Button
          type="button"
          variant="outline"
          className="loan-action"
          disabled={isLocked}
          onClick={(event) => {
            actions.confirm({
              title: 'Відмовити в запиті?',
              description:
                'Позичальник отримає сповіщення. Книжка лишиться вільною для інших запитів.',
              confirmLabel: 'Відмовити',
              dismissLabel: 'Не відмовляти',
              run: () => actions.act(loan, 'reject'),
              opener: event.currentTarget,
            })
          }}
        >
          Відмовити
        </Button>
        <Button
          type="button"
          className="loan-action loan-action--primary"
          disabled={isLocked}
          aria-busy={isApproving}
          onClick={() => void actions.act(loan, 'approve', form.body)}
        >
          {isApproving && (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          )}
          {isApproving
            ? 'Погоджую…'
            : form.dueAt === ''
              ? 'Погодити без терміну'
              : `Погодити до ${shortDay(form.dueAt)}`}
        </Button>
      </div>
    </section>
  )
}

type OutcomeCardProps = {
  outcome: OwnerRequestOutcome
  backHref: string
  onOpenLoan: () => void
  titleRef: RefObject<HTMLHeadingElement | null>
}

function OutcomeCard({ outcome, backHref, onOpenLoan, titleRef }: OutcomeCardProps) {
  const Icon = OUTCOME_ICONS[outcome.tone]

  return (
    <section className="loan-outcome" data-tone={outcome.tone} role="status">
      <div className="loan-outcome__head">
        <span className="loan-outcome__icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="loan-outcome__words">
          <h4 ref={titleRef} tabIndex={-1} className="loan-outcome__title">
            {outcome.title}
          </h4>
          <p className="loan-outcome__text">{outcome.text}</p>
        </div>
      </div>
      <div className="loan-form-actions loan-form-actions--start">
        {outcome.canOpenLoan && (
          <Button type="button" className="loan-action loan-action--primary" onClick={onOpenLoan}>
            Відкрити позику
          </Button>
        )}
        <Link className="loan-action loan-action--link" href={backHref}>
          До позичань
        </Link>
      </div>
    </section>
  )
}
