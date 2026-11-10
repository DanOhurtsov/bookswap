import type { Loan, LoanListResponse, PublicUser } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { countNoun, timeAgo } from '@/app/lib/time-ago'
import { shortDay } from './loan-term'

/** The canvas shows three requests; the rest are behind «Переглянути всі». */
export const INCOMING_REQUESTS_SHOWN = 3

/** Where every request on the owner's books is: the owner's side of `/loans`. */
export const INCOMING_REQUESTS_HREF = '/loans?role=owner'

/** One request on the owner's book — everything the card renders, already decided. */
export interface IncomingRequestCard {
  /** The loan itself: the approval form and the actions act on it. */
  loan: Loan
  /** The title is a link to this one loan on `/loans`. */
  href: string
  borrower: PublicUser
  /** The instant, for `<time dateTime>`. */
  requestedAt: string
  /** «2 год тому» — counted from when the list was read. */
  requestedAgo: string
  /** Picks the drawn cover's colours: the work, as on every canvas shelf. */
  bookId: string
  title: string
  /** «Авторка, Автор»; empty when the work has none. */
  authors: string
  coverUrl: string | null
  /** The date the borrower asked for, if they did: the day for `<time>` and «15.11.26». */
  proposedDue: { date: string; label: string } | null
  message: string | null
}

export type IncomingRequestsView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  /** `total` counts every request; `cards` are the newest of them. */
  | { kind: 'ready'; total: number; totalLabel: string; cards: IncomingRequestCard[] }

export interface IncomingRequestsViewInput {
  data: LoanListResponse | undefined
  error: unknown
  isError: boolean
  /** A read is under way — a manual retry after an error, say. */
  isFetching: boolean
  /** When `data` was read (ms): «тому» is counted from it, so a render never reads the clock. */
  readAt: number
}

const LOAD_FAILED = 'Не вдалося завантажити запити на ваші книжки.'

/**
 * BS-147, «Потребує вашої дії»: the requests on the owner's books, newest first as the API sends them.
 * As in the sections beside it, an error is shown once the read has settled, and a failed refresh hides
 * the cards it had: an answer to a request that may be gone is not offered.
 */
export function toIncomingRequestsView({
  data,
  error,
  isError,
  isFetching,
  readAt,
}: IncomingRequestsViewInput): IncomingRequestsView {
  if (isError && !isFetching) {
    return { kind: 'error', message: `${LOAD_FAILED} ${describeError(error)}`.trim() }
  }
  if (data === undefined || isError) return { kind: 'loading' }
  if (data.loans.length === 0) return { kind: 'empty' }

  const total = data.loans.length

  return {
    kind: 'ready',
    total,
    totalLabel: countNoun(total, ['запит', 'запити', 'запитів']),
    cards: data.loans.slice(0, INCOMING_REQUESTS_SHOWN).map((loan) => {
      const requestedAt = loan.requestedAt ?? loan.createdAt

      return {
        loan,
        href: `/loans?loanId=${encodeURIComponent(loan.id)}`,
        borrower: loan.borrower,
        requestedAt,
        requestedAgo: timeAgo(requestedAt, readAt),
        bookId: loan.work.id,
        title: loan.work.title,
        authors: loan.authors.map((author) => author.name).join(', '),
        coverUrl: loan.edition.coverUrl,
        proposedDue: loan.dueAt === null ? null : { date: loan.dueAt, label: shortDay(loan.dueAt) },
        message: loan.message,
      }
    }),
  }
}

/**
 * An answer to a request that is no longer waiting — answered in another tab, cancelled by the borrower,
 * turned down when another request for the copy was approved. The list is read again, so the stale card
 * goes; the explanation stays with the section, since it must outlive the card it came from.
 */
export function isAnswerConflict(failure: unknown): failure is ApiRequestError {
  return failure instanceof ApiRequestError && failure.code === 'LOAN_INVALID_TRANSITION'
}

/** What the section says after such a conflict: which request, and the server's reason. */
export function answerConflictMessage(title: string, failure: ApiRequestError): string {
  return `Не вдалося відповісти на запит на «${title}». ${failure.message}`
}
