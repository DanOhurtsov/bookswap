import type {
  ProfileActivity,
  ProfileBook,
  ProfileBookPlace,
  ProfileCounterpart,
  ProfileLoanEvent,
} from '@bookswap/shared'
import {
  toEdition,
  toWork,
  toWorkAuthors,
  type EditionRow,
  type WorkAuthorRow,
  type WorkRow,
} from '../../catalog/catalog.mapper'
import { isHome } from '../../library/library.mapper'
import { isOverdue, toIsoDay } from '../../loans/loan.mapper'
import { toPublicUser, type PublicUserRow } from '../user.mapper'
import type { CopyModel, LoanModel } from '../../generated/prisma/models'
import type { LoanStatus } from '../../generated/prisma/enums'

/**
 * BS-148, sub-stage E: pure projections of the profile summary. No Prisma client and no Nest, so the
 * «where is my book» and «what happened lately» rules are unit-tested without PostgreSQL.
 */

/** A guest contact as the owner named them; `null` once the contact is erased (D3). */
type ContactRow = { alias: string } | null

/** An open loan on my copy — enough to name who has it or who it is promised to. */
export type SummaryCopyLoanRow = Pick<LoanModel, 'status' | 'dueAt'> & {
  borrower: PublicUserRow | null
  borrowerContact: ContactRow
}

export type SummaryCopyRow = Pick<
  CopyModel,
  'id' | 'ownerId' | 'currentHolderId' | 'heldByContactId' | 'status'
> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
  currentHolder: PublicUserRow | null
  heldByContact: ContactRow
  /** Only open loans (`OPEN_LOAN_STATUS`). */
  loans: SummaryCopyLoanRow[]
}

export function counterpartOf(user: PublicUserRow | null, contact: ContactRow): ProfileCounterpart {
  return user === null
    ? { kind: 'GUEST', alias: contact?.alias ?? null }
    : { kind: 'USER', user: toPublicUser(user) }
}

export function placeOf(copy: SummaryCopyRow, now: Date): ProfileBookPlace {
  if (!isHome(copy)) {
    const holder = counterpartOf(copy.currentHolder, copy.heldByContact)

    // §5.1: a loss leaves the copy UNAVAILABLE and the holder on the borrower — it is not back home.
    if (copy.status === 'UNAVAILABLE') return { kind: 'LOST', holder }

    const loan = copy.loans.find((candidate) => candidate.status === 'HANDED_OVER')

    return {
      kind: 'LENT',
      holder,
      dueAt: toIsoDay(loan?.dueAt ?? null),
      overdue: loan === undefined ? false : isOverdue(loan, now),
    }
  }

  if (copy.status === 'UNAVAILABLE') return { kind: 'UNAVAILABLE' }

  if (copy.status === 'RESERVED') {
    // Approved request, or an owner's record waiting for the borrower (Stage 10, 10e/10i).
    const loan = copy.loans.find(
      (candidate) => candidate.status === 'APPROVED' || candidate.status === 'PENDING_CONFIRMATION',
    )

    return {
      kind: 'RESERVED',
      borrower: counterpartOf(loan?.borrower ?? null, loan?.borrowerContact ?? null),
    }
  }

  const pendingRequestCount = copy.loans.filter((loan) => loan.status === 'REQUESTED').length

  return pendingRequestCount > 0
    ? { kind: 'HOME_REQUESTED', pendingRequestCount }
    : { kind: 'HOME' }
}

export function toProfileBook(copy: SummaryCopyRow, now: Date): ProfileBook {
  return {
    copyId: copy.id,
    edition: toEdition(copy.edition),
    work: toWork(copy.edition.work),
    authors: toWorkAuthors(copy.edition.work.authors),
    place: placeOf(copy, now),
  }
}

// --- Activity -----------------------------------------------------------------

/**
 * A handover that really happened. A record still waiting for the borrower (or declined by them) has a
 * `handedAt` too — the owner's claim — and is not one.
 */
export const HANDED_LOAN_STATUSES: LoanStatus[] = ['HANDED_OVER', 'RETURNED', 'LOST']

export type ActivityLoanRow = Pick<
  LoanModel,
  'id' | 'ownerId' | 'origin' | 'status' | 'requestedAt' | 'respondedAt' | 'handedAt' | 'returnedAt'
> & {
  owner: PublicUserRow
  borrower: PublicUserRow | null
  borrowerContact: ContactRow
  copy: { edition: { work: Pick<WorkRow, 'id' | 'title'> } }
}

/** Copies I added on one calendar day (UTC): how many, and when the last of them was added. */
export interface AddedCopiesDay {
  count: number
  at: Date
}

/**
 * The steps a loan's timestamps prove. The service's queries filter by the same rules
 * (`HANDED_LOAN_STATUSES`, `origin = REQUESTED`) — a step this function drops must not take a place in
 * the «latest five» there.
 *
 * Request steps exist only for `origin = REQUESTED`: a recorded loan has no request (Stage 10, T2).
 * `respondedAt` is stamped by both approve and reject, so the final status tells which it was.
 */
export function loanStepsOf(loan: ActivityLoanRow): { event: ProfileLoanEvent; at: Date }[] {
  const steps: { event: ProfileLoanEvent; at: Date }[] = []

  if (loan.origin === 'REQUESTED') {
    if (loan.requestedAt !== null) steps.push({ event: 'REQUESTED', at: loan.requestedAt })
    if (loan.respondedAt !== null) {
      steps.push({
        event: loan.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        at: loan.respondedAt,
      })
    }
  }

  if (loan.handedAt !== null && HANDED_LOAN_STATUSES.includes(loan.status)) {
    steps.push({ event: 'HANDED_OVER', at: loan.handedAt })
  }

  if (loan.returnedAt !== null && loan.status === 'RETURNED') {
    steps.push({ event: 'RETURNED', at: loan.returnedAt })
  }

  return steps
}

function toLoanActivity(loan: ActivityLoanRow, viewerId: string): ProfileActivity[] {
  const asOwner = loan.ownerId === viewerId
  const counterpart = asOwner
    ? counterpartOf(loan.borrower, loan.borrowerContact)
    : counterpartOf(loan.owner, null)
  const { id, title } = loan.copy.edition.work

  return loanStepsOf(loan).map((step) => ({
    kind: 'LOAN',
    event: step.event,
    at: step.at.toISOString(),
    loanId: loan.id,
    role: asOwner ? 'OWNER' : 'BORROWER',
    counterpart,
    work: { id, title },
  }))
}

/**
 * The latest `limit` lines, newest first. A loan may arrive from several queries (one per
 * timestamp), so loans are taken once by id.
 */
export function latestActivity(
  loans: ActivityLoanRow[],
  addedDays: AddedCopiesDay[],
  viewerId: string,
  limit: number,
): ProfileActivity[] {
  const unique = [...new Map(loans.map((loan) => [loan.id, loan])).values()]
  const lines: ProfileActivity[] = [
    ...unique.flatMap((loan) => toLoanActivity(loan, viewerId)),
    ...addedDays.map((day): ProfileActivity => ({
      kind: 'COPIES_ADDED',
      at: day.at.toISOString(),
      count: day.count,
    })),
  ]

  return lines.sort((one, other) => Date.parse(other.at) - Date.parse(one.at)).slice(0, limit)
}

// --- Reliability --------------------------------------------------------------

const SECONDS_PER_DAY = 86_400

/** Mean loan length in whole days; `null` before the first returned loan. */
export function averageLoanDays(averageSeconds: number | null): number | null {
  return averageSeconds === null ? null : Math.round(averageSeconds / SECONDS_PER_DAY)
}
