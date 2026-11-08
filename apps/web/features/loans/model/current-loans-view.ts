import type { Loan, LoanRole } from '@bookswap/shared'
import { formatDate } from '@/app/lib/labels'
import {
  ALL_TAB,
  loanHref,
  type LoanSide,
  type LoansFilters,
  type QueryParameters,
} from './loans-address'
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
import { isOpenStatus, shownStatusOf } from './loan-status'

/**
 * BS-153: the current tabs — what is moving now and may need someone's action (PO, 05.11.2026). One
 * `GET /loans` carries both sides and every status; this keeps the open ones (`isOpenStatus`) and
 * splits them by side. The finished ones are in «Історія», which reads `GET /me/history`.
 *
 * The list is the whole of it — the API does not page it — so the counts are true totals.
 */
export type CurrentLoansView = LoanListView & {
  /** Open loans per tab, whatever the search and the status filter say. */
  counts: Readonly<Record<LoanSide, number>>
}

export type CurrentLoansInput = {
  loans: readonly Loan[]
  userId: string
  side: LoanSide
  filters: LoansFilters
  /** The list's own address: a row keeps it beside the loan's id, so the loan's page can return here. */
  parameters: QueryParameters
}

export const CURRENT_RELATIONS: Readonly<Record<LoanRole, string>> = {
  borrower: 'Я позичаю',
  owner: 'У мене позичає',
}

export function toCurrentLoansView({
  loans,
  userId,
  side,
  filters,
  parameters,
}: CurrentLoansInput): CurrentLoansView {
  const open = loans
    .filter((loan) => isOpenStatus(loan.status))
    .map((loan) => ({ loan, role: roleOf(loan, userId) }))
  const counts = {
    [ALL_TAB]: open.length,
    owner: open.filter(({ role }) => role === 'owner').length,
    borrower: open.filter(({ role }) => role === 'borrower').length,
  }
  const candidates = open
    .filter(({ role }) => side === ALL_TAB || role === side)
    .map(({ loan, role }) => toCandidate(loan, role, loanHref(parameters, side, loan.id)))

  return {
    ...toListView(
      candidates,
      filters,
      side === ALL_TAB || counts.all === 0 ? 'none' : 'side',
      side === ALL_TAB ? 'Спробуйте інший статус.' : 'Спробуйте інший статус або вкладку «Усі».',
    ),
    counts,
  }
}

/** The side is the one the server granted access by: the owner's id, nothing from the address. */
function roleOf(loan: Loan, userId: string): LoanRole {
  return loan.owner.id === userId ? 'owner' : 'borrower'
}

function toCandidate(loan: Loan, role: LoanRole, href: string): LoanRowCandidate {
  const counterpart = role === 'owner' ? loan.borrower : loan.owner
  const status = shownStatusOf(loan)
  const row: LoanRowView = {
    key: loan.id,
    href,
    action: VIEW_LOAN,
    bookId: loan.work.id,
    title: loan.work.title,
    authors: authorsLine(loan.authors),
    edition: editionLine(loan.edition),
    coverUrl: loan.edition.coverUrl,
    person: { name: counterpart.displayName, avatarUrl: counterpart.avatarUrl },
    relation: CURRENT_RELATIONS[role],
    direction: role === 'owner' ? 'out' : 'in',
    badge: badgeOf(status),
    hint: hintOf(loan, role),
    dates: dateOf(loan),
  }

  return { row, status, searchable: [row.title, row.authors, counterpart.displayName] }
}

/**
 * Whose move it is, in the words of an action the loan's page really offers (§5.1, Stage 10): the
 * borrower confirms receipt of an agreed or recorded loan, the owner answers a request. Nothing is
 * promised that the product cannot do — the owner, say, does not confirm a return by the borrower.
 */
function hintOf(loan: Loan, role: LoanRole): LoanRowView['hint'] {
  const isOwner = role === 'owner'

  if (loan.isOverdue && loan.dueAt !== null) {
    return { text: `Мало повернутись ${formatDate(loan.dueAt)}`, isAlert: true }
  }

  switch (loan.status) {
    case 'REQUESTED':
      return note(isOwner ? 'Чекає вашої відповіді' : 'Чекає відповіді власника')
    case 'APPROVED':
      return note(
        isOwner
          ? 'Чекає, поки позичальник підтвердить отримання'
          : 'Підтвердьте, коли отримаєте книжку',
      )
    case 'PENDING_CONFIRMATION':
      return note(isOwner ? 'Чекає підтвердження позичальника' : 'Підтвердьте або відхиліть запис')
    default:
      return null
  }
}

function note(text: string): LoanRowView['hint'] {
  return { text, isAlert: false }
}

/**
 * The one date that says where the loan stands, labelled by what it is. A request is dated by the
 * request; a recorded loan by its record — `origin` decides, as `requestedAt` of a recorded loan is
 * a database default, not a request (Stage 10, T2). `dueAt` is a term, never a return.
 */
function dateOf(loan: Loan): string[] {
  switch (loan.status) {
    case 'REQUESTED':
      return loan.requestedAt === null ? [] : [`Попросили ${formatDate(loan.requestedAt)}`]
    case 'APPROVED':
      return loan.respondedAt === null ? [] : [`Погоджено ${formatDate(loan.respondedAt)}`]
    case 'PENDING_CONFIRMATION':
      return [`Записано власником ${formatDate(loan.createdAt)}`]
    case 'HANDED_OVER':
      if (loan.dueAt !== null && !loan.isOverdue) return [`Повернути до ${formatDate(loan.dueAt)}`]
      return loan.handedAt === null ? [] : [`Передано ${formatDate(loan.handedAt)}`]
    default:
      return []
  }
}
