import { API_ERROR_CODES } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { shortDay, type Day } from './loan-term'

/**
 * The canvas's «Попросити книжку», on the existing flow: `POST /loans` for one copy (§8). Where the
 * request stands is decided by the server's answer only — «Запит надіслано» needs the created loan, and
 * a 409 is told by its code: the copy is no longer free, the request already exists, or the owner has
 * paused requests. Anything else is a failure the person may retry with what they typed.
 */
export type BorrowPhase =
  | { kind: 'draft' }
  | { kind: 'sending' }
  | { kind: 'failed'; failure: unknown }
  | { kind: 'sent'; loanId: string }
  | { kind: 'duplicate' }
  | { kind: 'unavailable' }
  | { kind: 'paused' }

export type ClosedBorrowPhase = Extract<
  BorrowPhase,
  { kind: 'sent' | 'duplicate' | 'unavailable' | 'paused' }
>

export function phaseOfFailure(failure: unknown): BorrowPhase {
  if (failure instanceof ApiRequestError) {
    switch (failure.code) {
      case API_ERROR_CODES.LOAN_DUPLICATE_REQUEST:
        return { kind: 'duplicate' }
      case API_ERROR_CODES.LOAN_COPY_UNAVAILABLE:
        return { kind: 'unavailable' }
      case API_ERROR_CODES.LOAN_REQUESTS_PAUSED:
        return { kind: 'paused' }
    }
  }

  return { kind: 'failed', failure }
}

export function isClosedPhase(phase: BorrowPhase): phase is ClosedBorrowPhase {
  return (
    phase.kind === 'sent' ||
    phase.kind === 'duplicate' ||
    phase.kind === 'unavailable' ||
    phase.kind === 'paused'
  )
}

export type BorrowOutcome = {
  tone: 'ok' | 'info' | 'warn'
  title: string
  text: string
  /** The request this person has on the copy, to open on `/loans`; `null` when there is none. */
  loanId: string | null
}

export type BorrowOutcomeInput = {
  phase: ClosedBorrowPhase
  ownerName: string
  /** The viewer's own open loan on the copy, once the library is read again after a 409. */
  myLoanId: string | null
  /** «орієнтовно вільна» of the re-read copy (§6.5), if the owner set one. */
  expectedReturnAt: Day | null
}

/** What the panel says once the request is settled. Nothing the product does not do is promised. */
export function borrowOutcomeOf({
  phase,
  ownerName,
  myLoanId,
  expectedReturnAt,
}: BorrowOutcomeInput): BorrowOutcome {
  switch (phase.kind) {
    case 'sent':
      return {
        tone: 'ok',
        title: 'Запит надіслано',
        text: `${ownerName} отримає сповіщення і зможе погодити запит, змінивши дату, або відмовити. Про відповідь вам прийде сповіщення.`,
        loanId: phase.loanId,
      }
    case 'duplicate':
      return {
        tone: 'info',
        title: 'Запит уже надіслано',
        text: 'Ви вже просили цю книжку, і власник ще не відповів — новий запит не потрібен.',
        loanId: myLoanId,
      }
    case 'unavailable':
      return {
        tone: 'warn',
        title: 'Книжку зараз не можна попросити',
        text: [
          'Поки ви заповнювали запит, примірник став недоступним.',
          expectedReturnAt === null ? null : `Орієнтовно вільна з ${shortDay(expectedReturnAt)}.`,
        ]
          .filter((sentence) => sentence !== null)
          .join(' '),
        loanId: null,
      }
    case 'paused':
      return {
        tone: 'warn',
        title: 'Власник зараз не приймає запитів',
        text: `${ownerName} тимчасово не приймає запитів на позичання. Спробуйте пізніше.`,
        loanId: null,
      }
  }
}

/** A failed send: what went wrong, then that nothing typed is lost. */
export function sendFailureText(failure: unknown): string {
  const kept = 'Дата й повідомлення збережені.'

  if (failure instanceof ApiRequestError && failure.status < 500) {
    return `Не вдалося надіслати запит. ${failure.message} ${kept}`
  }

  return `Не вдалося надіслати запит. Перевірте зʼєднання і спробуйте ще раз. ${kept}`
}
