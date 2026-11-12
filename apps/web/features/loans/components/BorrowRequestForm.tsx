'use client'

import Link from 'next/link'
import { useEffect, useId, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  InfoIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { LOAN_LIMITS } from '@bookswap/shared'
import { useMediaQuery } from '@/app/lib/use-media-query'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  borrowOutcomeOf,
  isClosedPhase,
  sendFailureText,
  type BorrowOutcome,
  type ClosedBorrowPhase,
} from '../model/borrow-request'
import { localDay, type Day } from '../model/loan-term'
import { borrowerLoanHref } from '../model/loans-address'
import { useBorrowRequest, type BorrowRequest } from '../model/use-borrow-request'
import { LoanTermField } from './LoanTermField'

/** From here the form fits under the copy; below it, it takes a sheet of its own. */
const FITS_INLINE = '(min-width: 48rem)'

const OUTCOME_ICONS: Readonly<Record<BorrowOutcome['tone'], LucideIcon>> = {
  ok: CircleCheckIcon,
  info: InfoIcon,
  warn: ClockIcon,
}

export type BorrowRequestFormProps = {
  copyId: string
  /** The book, named in the phone's sheet: the shelf it was asked from is hidden under it. */
  bookTitle: string
  ownerName: string
  /** The viewer's own open loan on this copy, as the shelf says it now. */
  myLoanId: string | null
  /** «орієнтовно вільна» of the copy (§6.5), as the shelf says it now. */
  expectedReturnAt: Day | null
  /** Reads the shelf again once the request is settled, told how it was. */
  onSettled: (outcome: ClosedBorrowPhase) => Promise<void> | void
  /** «Скасувати» and «Закрити» — in the sheet also Escape and its ✕: back to the shelf as it is. */
  onClose: () => void
}

/**
 * The canvas's «Попросити книжку» as the shelf's own form, opened by «Попросити» under the copy: the
 * date the borrower would like, a note, and the request — then what the server made of it. It wears the
 * canvas palette (`.canvas-palette`) on a page that does not.
 *
 * Where it is too narrow for the calendar under the copy (a phone), the same form opens in a bottom
 * sheet over the shelf. The request lives here, above both: a turn of the phone moves the form from one
 * to the other with what was typed, the date and a failure as they were.
 */
export function BorrowRequestForm({
  copyId,
  bookTitle,
  onSettled,
  onClose,
  ...rest
}: BorrowRequestFormProps) {
  const request = useBorrowRequest(copyId, onSettled)
  const fitsInline = useMediaQuery(FITS_INLINE)
  const body = <BorrowRequestBody request={request} onClose={onClose} {...rest} />

  if (fitsInline) return body

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        // A request on its way is not walked away from: its answer decides what the shelf shows.
        if (!open && request.phase.kind !== 'sending') onClose()
      }}
    >
      <SheetContent side="bottom" className="canvas-palette borrow-sheet">
        <SheetHeader className="borrow-sheet__head">
          <SheetTitle className="borrow-sheet__title">Попросити книжку</SheetTitle>
          <SheetDescription className="borrow-sheet__book">{bookTitle}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  )
}

type BorrowRequestBodyProps = Omit<BorrowRequestFormProps, 'copyId' | 'bookTitle' | 'onSettled'> & {
  request: BorrowRequest
}

/** The form, or once the request is settled, its outcome — the same under the copy and in the sheet. */
function BorrowRequestBody({
  request,
  ownerName,
  myLoanId,
  expectedReturnAt,
  onClose,
}: BorrowRequestBodyProps) {
  const { phase } = request
  const noteId = useId()
  const countId = useId()
  const outcomeTitle = useRef<HTMLHeadingElement>(null)
  const isSending = phase.kind === 'sending'
  const isClosed = isClosedPhase(phase)

  // The pressed button is gone with the form: the outcome takes the focus.
  useEffect(() => {
    if (isClosed) outcomeTitle.current?.focus()
  }, [isClosed])

  if (isClosed) {
    const outcome = borrowOutcomeOf({ phase, ownerName, myLoanId, expectedReturnAt })
    const Icon = OUTCOME_ICONS[outcome.tone]

    return (
      <section className="canvas-palette loan-outcome" data-tone={outcome.tone} role="status">
        <div className="loan-outcome__head">
          <span className="loan-outcome__icon" aria-hidden="true">
            <Icon />
          </span>
          <div className="loan-outcome__words">
            <h3 ref={outcomeTitle} tabIndex={-1} className="loan-outcome__title">
              {outcome.title}
            </h3>
            <p className="loan-outcome__text">{outcome.text}</p>
          </div>
        </div>
        <div className="loan-form-actions loan-form-actions--start">
          {outcome.loanId !== null && (
            <Link
              className="loan-action loan-action--primary loan-action--link"
              href={borrowerLoanHref(outcome.loanId)}
            >
              Відкрити запит
            </Link>
          )}
          <Button type="button" variant="outline" className="loan-action" onClick={onClose}>
            Закрити
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="canvas-palette borrow-request" aria-label="Новий запит">
      <LoanTermField
        value={request.proposedDueAt}
        onChange={request.setProposedDueAt}
        today={localDay(new Date())}
        hint="До якого дня вам потрібна книжка? Це побажання: остаточну дату вкаже власник, погоджуючи запит."
        empty={{ title: 'Без дати', text: 'Дату повернення, якщо потрібно, вкаже власник.' }}
        canClear
        isLocked={isSending}
      />

      <div className="loan-note">
        <div className="loan-note__head">
          <label htmlFor={noteId} className="loan-note__label">
            Повідомлення власнику <span>(необовʼязково)</span>
          </label>
          <span id={countId} className="loan-note__count">
            {request.message.length}/{LOAN_LIMITS.messageMax}
          </span>
        </div>
        <textarea
          id={noteId}
          className="loan-note__field"
          aria-describedby={countId}
          maxLength={LOAN_LIMITS.messageMax}
          placeholder="Наприклад, навіщо книжка і коли зручно її забрати"
          value={request.message}
          disabled={isSending}
          onChange={(event) => {
            request.setMessage(event.target.value)
          }}
        />
      </div>

      {phase.kind === 'failed' && (
        <div className="loan-alert" role="alert">
          <CircleAlertIcon aria-hidden="true" />
          <p>{sendFailureText(phase.failure)}</p>
        </div>
      )}

      <div className="loan-form-actions">
        <Button
          type="button"
          variant="outline"
          className="loan-action"
          disabled={isSending}
          onClick={onClose}
        >
          Скасувати
        </Button>
        <Button
          type="button"
          className="loan-action loan-action--primary"
          disabled={isSending}
          focusableWhenDisabled
          aria-busy={isSending}
          onClick={() => void request.send()}
        >
          {isSending && (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          )}
          {isSending ? 'Надсилаю…' : 'Надіслати запит'}
        </Button>
      </div>
    </section>
  )
}
