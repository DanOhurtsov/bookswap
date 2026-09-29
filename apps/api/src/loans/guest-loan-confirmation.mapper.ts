import {
  guestLoanEvidenceOf,
  type GuestLoanConfirmation,
  type GuestLoanConfirmationStatus,
  type LoanStatus,
} from '@bookswap/shared'
import { toEdition, toWork, toWorkAuthors } from '../catalog/catalog.mapper'
import { isOverdue, toIsoDay } from './loan.mapper'
import type { GuestLoanCopyRow } from './guest-loan.mapper'
import type { ExternalBorrowerModel, LoanModel } from '../generated/prisma/models'

/**
 * Stage 10 (10i.1): чиста проєкція owner-only ресурсу запиту гостьового підтвердження. Та сама
 * розмежованість, що `guest-loan.mapper.ts`: тут межу статусів `Loan` тримає `asGuestConfirmation`,
 * а не CHECK (`loan_borrower_kind_valid` статус не обмежує).
 */

/** Статуси `Loan`, можливі для рядка підтвердження: очікування, скасування й наслідки запису. */
export const GUEST_CONFIRMATION_LOAN_STATUSES: readonly LoanStatus[] = [
  'PENDING_CONFIRMATION',
  'CANCELLED',
  'HANDED_OVER',
  'RETURNED',
  'LOST',
]

export type GuestConfirmationLoanStatusValue =
  'PENDING_CONFIRMATION' | 'CANCELLED' | 'HANDED_OVER' | 'RETURNED' | 'LOST'

export type GuestConfirmationRow = {
  id: string
  status: GuestLoanConfirmationStatus
  createdAt: Date
  resolvedAt: Date | null
  /** Лише час видачі/строк ПОТОЧНОГО посилання; геш токена мапер не бачить і не віддає. */
  linkIssuedAt: Date | null
  linkExpiresAt: Date | null
  loan: Pick<LoanModel, 'id' | 'createdAt' | 'returnedAt' | 'dueAt'> & {
    status: GuestConfirmationLoanStatusValue
    /** `asGuestConfirmation` гарантує `NOT NULL`: запит створюють лише після фізичної передачі. */
    handedAt: Date
    copy: GuestLoanCopyRow
  }
  /** `null` після видалення контакту (FK `SET NULL`): рядок і позика лишаються. */
  externalBorrower: Pick<
    ExternalBorrowerModel,
    'id' | 'alias' | 'guestNickname' | 'guestEmail' | 'guestEmailVerifiedAt'
  > | null
}

export type UnvalidatedGuestConfirmationRow = Omit<GuestConfirmationRow, 'loan'> & {
  loan: Omit<GuestConfirmationRow['loan'], 'status' | 'handedAt'> & {
    status: LoanStatus
    handedAt: Date | null
  }
}

/** Друга лінія захисту після SQL-фільтра читачів: невалідний рядок → `null`. */
export function asGuestConfirmation(
  row: UnvalidatedGuestConfirmationRow,
): GuestConfirmationRow | null {
  if (row.loan.handedAt === null) return null
  if (!GUEST_CONFIRMATION_LOAN_STATUSES.includes(row.loan.status)) return null

  return row as GuestConfirmationRow
}

export function toGuestConfirmation(
  row: GuestConfirmationRow,
  now: Date = new Date(),
): GuestLoanConfirmation {
  const { loan, externalBorrower } = row

  return {
    id: row.id,
    status: row.status,
    evidence: guestLoanEvidenceOf(row.status),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    link:
      row.linkIssuedAt === null || row.linkExpiresAt === null
        ? null
        : {
            issuedAt: row.linkIssuedAt.toISOString(),
            expiresAt: row.linkExpiresAt.toISOString(),
            isExpired: row.linkExpiresAt.getTime() <= now.getTime(),
          },
    loan: {
      id: loan.id,
      status: loan.status,
      isOverdue: isOverdue(loan, now),
      createdAt: loan.createdAt.toISOString(),
      handedAt: loan.handedAt.toISOString(),
      returnedAt: loan.returnedAt?.toISOString() ?? null,
      dueAt: toIsoDay(loan.dueAt),
    },
    copy: {
      id: loan.copy.id,
      status: loan.copy.status,
      condition: loan.copy.condition,
      isArchived: loan.copy.archivedAt !== null,
    },
    edition: toEdition(loan.copy.edition, loan.copy.edition.work),
    work: toWork(loan.copy.edition.work),
    authors: toWorkAuthors(loan.copy.edition.work.authors),
    contact:
      externalBorrower === null
        ? null
        : {
            id: externalBorrower.id,
            alias: externalBorrower.alias,
            guestNickname: externalBorrower.guestNickname,
            guestEmail: externalBorrower.guestEmail,
            guestEmailVerifiedAt: externalBorrower.guestEmailVerifiedAt?.toISOString() ?? null,
          },
  }
}
