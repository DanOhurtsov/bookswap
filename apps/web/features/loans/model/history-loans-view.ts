import type { MyHistoryResponse } from '@bookswap/shared'
import { GUEST_EVIDENCE_LABELS, formatDate } from '@/app/lib/labels'
import { HISTORY_TAB, loanHref, type LoansFilters, type QueryParameters } from './loans-address'
import { toLoanHistory, type HistoryDirection, type LoanHistoryRow } from './loan-history'
import {
  authorsLine,
  badgeOf,
  editionLine,
  toListView,
  type LoanListView,
  type LoanRowCandidate,
  type LoanRowView,
  VIEW_LOAN,
} from './loan-row'
import { shownStatusOf } from './loan-status'

/**
 * BS-153: «Історія» in the rows of the canvas. The records, their order and what each one says are
 * BS-142's (`toLoanHistory`): every record of both directions, open ones included — that is an agreed
 * rule, not a leftover. The status filter offers only the statuses that end a loan (PO, 05.11.2026),
 * so an open record is found by search or under «Усі статуси».
 *
 * Names come only from the API: a registered side of my own loan is always named, a guest record
 * carries none, and nothing here fills that gap.
 */
export function toHistoryLoansView(
  history: MyHistoryResponse,
  filters: LoansFilters,
  /** The list's own address, kept beside a loan's id so its page can return here. */
  parameters: QueryParameters,
): LoanListView {
  return toListView(
    toLoanHistory(history).map((record) => toCandidate(record, parameters)),
    filters,
    'none',
    'Спробуйте інший статус.',
  )
}

export const HISTORY_RELATIONS: Readonly<Record<HistoryDirection, string>> = {
  borrowed: 'Ви позичили',
  lent: 'Ви дали почитати',
}

const UNKNOWN_DATE = 'не вказано'

/** A guest record has no loan to open; its copy's history is where the record leads (as before BS-153). */
const VIEW_COPY_HISTORY = 'Переглянути історію примірника'

function toCandidate(record: LoanHistoryRow, parameters: QueryParameters): LoanRowCandidate {
  const { entry, copy } = record
  const counterpart = !entry.names
    ? null
    : record.direction === 'borrowed'
      ? entry.owner
      : entry.borrower
  const status = shownStatusOf(entry)
  const row: LoanRowView = {
    key: record.key,
    ...(entry.names
      ? { href: loanHref(parameters, HISTORY_TAB, entry.loanId), action: VIEW_LOAN }
      : { href: `/copies/${encodeURIComponent(copy.id)}/history`, action: VIEW_COPY_HISTORY }),
    bookId: copy.work.id,
    title: copy.work.title,
    authors: authorsLine(copy.authors),
    edition: editionLine(copy.edition),
    coverUrl: copy.edition.coverUrl,
    person: {
      name: counterpart?.displayName ?? null,
      avatarUrl: counterpart?.avatarUrl ?? null,
    },
    relation: HISTORY_RELATIONS[record.direction],
    direction: record.direction === 'borrowed' ? 'in' : 'out',
    badge: badgeOf(status),
    hint: { text: originLine(record), isAlert: false },
    dates: datesOf(record),
  }

  return {
    row,
    status,
    searchable: [
      row.title,
      row.authors,
      ...(counterpart === null ? [] : [counterpart.displayName]),
    ],
  }
}

/**
 * The actual dates, each named (BS-142): a missing one is «не вказано», never the request date; the
 * ending is shown on its own except for an open loan and a returned one; `dueAt` is the agreed term.
 */
function datesOf({ entry, completedAt, showsCompletedAt }: LoanHistoryRow): string[] {
  const facts = [
    `Передано: ${dateOrUnknown(entry.handedAt)}`,
    `Повернено: ${dateOrUnknown(entry.returnedAt)}`,
  ]

  if (showsCompletedAt) facts.push(`Завершено: ${dateOrUnknown(completedAt)}`)

  const dates = [facts.join(' · ')]

  if (entry.dueAt !== null) {
    dates.push(
      `Строк повернення до ${formatDate(entry.dueAt)}${entry.isOverdue ? ' · прострочено' : ''}`,
    )
  }

  return dates
}

function dateOrUnknown(iso: string | null): string {
  return iso === null ? UNKNOWN_DATE : formatDate(iso)
}

/**
 * Whether there was a request comes from `origin`, not `requestedAt`: the DB defaults it to now(),
 * so a loan the owner recorded may carry a `requestedAt` nobody sent.
 */
function originLine({ entry }: LoanHistoryRow): string {
  const parts = [
    entry.origin !== 'REQUESTED'
      ? 'Записано власником'
      : `Попросили ${dateOrUnknown(entry.requestedAt)}`,
  ]

  // Stage 10 (10i.3): where a guest handover's evidence comes from — no private data of the guest.
  if (entry.guestEvidence !== null) {
    parts.push(`джерело: ${GUEST_EVIDENCE_LABELS[entry.guestEvidence]}`)
  }

  return parts.join(' · ')
}
