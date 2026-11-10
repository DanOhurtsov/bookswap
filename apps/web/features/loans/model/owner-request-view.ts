import type { Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { COPY_STATUS_LABELS } from '@/app/lib/labels'
import { personHref } from '@/app/lib/person-href'
import { authorsLine, badgeOf, editionLine, type LoanRowView } from './loan-row'
import { shownStatusOf } from './loan-status'
import { localDay, shortDay, type Day } from './loan-term'

/**
 * The canvas's «Запит до власника»: the owner's own page of a request (`/loans?loanId=`) while it waits
 * for the answer, and the answer's outcome after it. Only what the loan carries is shown: the canvas's
 * reliability, shared friends, loans together and the other requests on the book have no data in the
 * contract and are left out rather than made up.
 *
 * The outcome comes from the loan as the server has it now, never from a pressed button: the page only
 * says «Запит погоджено» once a re-read loan is `APPROVED`.
 */
export type OwnerRequestView = {
  badge: LoanRowView['badge']
  /** «Надіслано 08.11.26»; `null` without a request date. */
  sentLabel: string | null
  borrower: { name: string; handle: string; avatarUrl: string | null; href: string }
  message: { text: string; label: string } | null
  book: {
    id: string
    title: string
    /** «Джордж Орвелл · Мʼяка обкладинка · 2021»; empty when nothing is known. */
    line: string
    authors: string
    coverUrl: string | null
    href: string
    copyState: string
  }
  /** The borrower's date, if they asked for one. */
  requested: Day | null
  /** `null` while the request is open: then the answer form is shown. */
  outcome: OwnerRequestOutcome | null
}

export type OutcomeTone = 'ok' | 'done' | 'info'

export type OwnerRequestOutcome = {
  tone: OutcomeTone
  title: string
  text: string
  /** «Відкрити позику» leads on to the loan's own page; a closed request has nothing more there. */
  canOpenLoan: boolean
}

export function toOwnerRequestView(loan: Loan): OwnerRequestView {
  const sent = loan.requestedAt ?? loan.createdAt
  const authors = authorsLine(loan.authors)

  return {
    badge: badgeOf(shownStatusOf(loan)),
    sentLabel: `Надіслано ${shortDay(localDay(new Date(sent)))}`,
    borrower: {
      name: loan.borrower.displayName,
      handle: `@${loan.borrower.handle}`,
      avatarUrl: loan.borrower.avatarUrl,
      href: personHref(loan.borrower),
    },
    message:
      loan.message === null
        ? null
        : { text: loan.message, label: `Повідомлення · ${shortDay(localDay(new Date(sent)))}` },
    book: {
      id: loan.work.id,
      title: loan.work.title,
      line: [authors, editionLine(loan.edition)].filter((part) => part !== '').join(' · '),
      authors,
      coverUrl: loan.edition.coverUrl,
      href: `/works/${encodeURIComponent(loan.work.id)}`,
      copyState: COPY_STATUS_LABELS[loan.copy.status],
    },
    requested: loan.status === 'REQUESTED' ? loan.dueAt : null,
    outcome: outcomeOf(loan),
  }
}

function outcomeOf(loan: Loan): OwnerRequestOutcome | null {
  switch (loan.status) {
    case 'REQUESTED':
      return null
    case 'APPROVED':
      return {
        tone: 'ok',
        title: 'Запит погоджено',
        text: [
          loan.dueAt === null ? 'Без дати повернення.' : `Повернути до ${shortDay(loan.dueAt)}.`,
          'Домовтеся про передачу книжки: отримання підтверджує позичальник.',
        ].join(' '),
        canOpenLoan: true,
      }
    case 'REJECTED':
      return {
        tone: 'done',
        title: 'Запит відхилено',
        text: 'Позичальник отримає сповіщення. Книжка лишається вільною.',
        canOpenLoan: false,
      }
    case 'CANCELLED':
      return {
        tone: 'info',
        title: 'Запит відкликано',
        text: 'Позичальник скасував запит, поки ви відповідали. Нічого робити не потрібно.',
        canOpenLoan: false,
      }
    default:
      return {
        tone: 'info',
        title: 'Запит уже опрацьовано',
        text: 'Відкрийте позику, щоб побачити, що з нею зараз.',
        canOpenLoan: true,
      }
  }
}

/** What the owner reads under the legend: the borrower's wish, and that the last word is the owner's. */
export function ownerTermHint(requested: Day | null): string {
  return requested === null
    ? 'Позичальник не вказав дату. Оберіть, до якого дня повернути книжку, або залиште без дати.'
    : `Позичальник просить до ${shortDay(requested)}. Остаточну дату повернення вказуєте ви.`
}

/**
 * A failed answer, in the canvas's words: what went wrong, then that nothing typed is lost. Without a
 * response the cause is the connection; with one, the server's own reason.
 */
export function answerFailureText(failure: unknown): string {
  const kept = 'Вибрана дата й повідомлення збережені.'

  if (failure instanceof ApiRequestError && failure.status < 500) {
    return `Не вдалося відповісти на запит. ${failure.message} ${kept}`
  }

  return `Не вдалося відповісти на запит. Перевірте зʼєднання і спробуйте ще раз. ${kept}`
}
