import {
  guestLoanEvidenceOf,
  type GuestLoan,
  type GuestLoanConfirmationStatus,
  type LoanEventType,
  type LoanStatus,
} from '@bookswap/shared'
import {
  toEdition,
  toWork,
  toWorkAuthors,
  type EditionRow,
  type WorkAuthorRow,
  type WorkRow,
} from '../catalog/catalog.mapper'
import { isOverdue, toIsoDay } from './loan.mapper'
import type { CopyModel, ExternalBorrowerModel, LoanModel } from '../generated/prisma/models'

/**
 * Stage 10 (10f.3): чиста проєкція гостьової позики — те саме розділення, що вже є для
 * `LoanRow`/`toLoan` (`loan.mapper.ts`), лише вужче за контрактом (жоден зареєстрований
 * користувач у гостьовій позиці участі не бере).
 */

export type GuestLoanCopyRow = Pick<CopyModel, 'id' | 'status' | 'condition' | 'archivedAt'> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
}

export type GuestLoanEventRow = {
  type: LoanEventType
  occurredAt: Date
  effectiveAt: Date | null
}

/**
 * Статуси, можливі для гостьової позики (§6.2 execution plan): `— → HANDED_OVER →
 * RETURNED | LOST`. CHECK `loan_borrower_kind_valid` (`schema.prisma`) обмежує лише
 * `borrowerId`/`borrowerContactId` відносно `borrowerKind` — він **не** обмежує `status` жодним
 * чином: рядок `borrowerKind = 'GUEST'` зі `status = 'REQUESTED'` пройшов би цей CHECK. Межу
 * статусів тримають самі читачі (`GuestLoanService`, WHERE-фільтр **до** захоплення локу), а ця
 * константа й `asGuestLoan` — друга, типізована лінія того самого фільтра, а не джерело істини.
 */
export const GUEST_LOAN_STATUSES: readonly LoanStatus[] = ['HANDED_OVER', 'RETURNED', 'LOST']

export type GuestLoanStatusValue = 'HANDED_OVER' | 'RETURNED' | 'LOST'

export type GuestLoanRow = Pick<LoanModel, 'id' | 'createdAt' | 'returnedAt' | 'dueAt'> & {
  status: GuestLoanStatusValue
  /** `asGuestLoan` гарантує `NOT NULL` (частина фільтра §6.2) — на відміну від `LoanModel`, де це поле nullable. */
  handedAt: Date
  copy: GuestLoanCopyRow
  /** `null` після `DELETE` контакту (FK `SET NULL`, D3/Q3d) — факт позики лишається. */
  borrowerContact: Pick<ExternalBorrowerModel, 'id' | 'alias'> | null
  /** Лише `RECOVERED`/`LOSS_CLOSED` — решта audit trail цим контрактом не віддається. */
  events: GuestLoanEventRow[]
  /**
   * Stage 10 (10i.1): лише статус рядка підтвердження (джерело доказу виводиться з нього). `null` для
   * старих ручних позик 10f.3, що рядка підтвердження не мають.
   */
  guestConfirmation: { status: GuestLoanConfirmationStatus } | null
}

/** Точно `GuestLoanRow`, лише зі `status`/`handedAt` ще не звуженими — форма, яку справді повертає Prisma. */
export type UnvalidatedGuestLoanRow = Omit<GuestLoanRow, 'status' | 'handedAt'> & {
  status: LoanStatus
  handedAt: Date | null
}

/**
 * Єдина брама з «сирого» рядка `Loan` (`status: LoanStatus`, будь-яке значення) у `GuestLoanRow`
 * (`status` звужено до трьох легітимних значень). Використовується як друга лінія захисту ПІСЛЯ
 * SQL-фільтра читачів — якщо він колись розійдеться з цим списком, `null` тут проявить розбіжність
 * одразу (виклик, що не очікує `null`, впаде), а не мовчки віддасть невалідний статус клієнту.
 */
export function asGuestLoan(row: UnvalidatedGuestLoanRow): GuestLoanRow | null {
  if (row.handedAt === null) return null
  if (!GUEST_LOAN_STATUSES.includes(row.status)) return null

  return row as GuestLoanRow
}

/**
 * Джерело доказу для позики, що вже перейшла в `HANDED_OVER`/`RETURNED`/`LOST`: без рядка підтвердження
 * (старий ручний запис) чи після `OWNER_RECORDED` — зі слів власника; після `RECEIVED` — підтверджено
 * гостем. Інші стани (`OPEN`/`DENIED`/`CANCELLED`) для такої позики неможливі — це порушена цілісність.
 */
function evidenceOfActive(loan: GuestLoanRow): GuestLoan['evidence'] {
  const evidence = guestLoanEvidenceOf(loan.guestConfirmation?.status ?? null)

  if (evidence !== 'OWNER_STATEMENT' && evidence !== 'GUEST_CONFIRMED') {
    throw new Error(
      `Позика ${loan.id}: статус ${loan.status} несумісний зі станом підтвердження ` +
        `${loan.guestConfirmation?.status ?? 'null'} — цілісність даних порушена`,
    )
  }

  return evidence
}

export function toGuestLoan(loan: GuestLoanRow, now: Date = new Date()): GuestLoan {
  const recovery = loan.events.find((event) => event.type === 'RECOVERED')
  const lossClosure = loan.events.find((event) => event.type === 'LOSS_CLOSED')

  return {
    id: loan.id,
    status: loan.status,
    evidence: evidenceOfActive(loan),
    isOverdue: isOverdue(loan, now),
    createdAt: loan.createdAt.toISOString(),
    handedAt: loan.handedAt.toISOString(),
    returnedAt: loan.returnedAt?.toISOString() ?? null,
    dueAt: toIsoDay(loan.dueAt),
    copy: {
      id: loan.copy.id,
      status: loan.copy.status,
      condition: loan.copy.condition,
      isArchived: loan.copy.archivedAt !== null,
    },
    edition: toEdition(loan.copy.edition),
    work: toWork(loan.copy.edition.work),
    authors: toWorkAuthors(loan.copy.edition.work.authors),
    contact: loan.borrowerContact === null ? null : { ...loan.borrowerContact },
    recovery:
      recovery === undefined
        ? null
        : {
            effectiveAt: (recovery.effectiveAt ?? recovery.occurredAt).toISOString(),
            recordedAt: recovery.occurredAt.toISOString(),
          },
    lossClosure:
      lossClosure === undefined ? null : { recordedAt: lossClosure.occurredAt.toISOString() },
  }
}
