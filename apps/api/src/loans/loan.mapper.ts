import type { Loan, LoanOrigin, LoanStatus } from '@bookswap/shared'
import {
  toEdition,
  toWork,
  toWorkAuthors,
  type EditionRow,
  type WorkAuthorRow,
  type WorkRow,
} from '../catalog/catalog.mapper'
import { toPublicUser, type PublicUserRow } from '../users/user.mapper'
import type { CopyModel, LoanModel } from '../generated/prisma/models'

/**
 * Чиста проєкція лоану. Ні Prisma-клієнта, ні Nest — тож похідний `isOverdue`
 * перевіряється unit-тестом без PostgreSQL.
 *
 * Проєкція одна, на відміну від трьох у бібліотеці, і це не непослідовність:
 * у лоану рівно дві сторони, обидві його учасники. §6.6 обмежує погляд **третьої**
 * людини — це історія, і в неї свій мапер із власними двома проєкціями.
 */

export type LoanCopyRow = Pick<CopyModel, 'id' | 'status' | 'condition' | 'archivedAt'> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
}

export type LoanRow = Pick<
  LoanModel,
  | 'id'
  | 'status'
  | 'message'
  | 'responseNote'
  | 'respondedAt'
  | 'handedAt'
  | 'returnedAt'
  | 'dueAt'
  | 'createdAt'
> & {
  origin: ServedOrigin
  /** `null` для записаної власником позики: запиту не було (Stage 10, T2). */
  requestedAt: Date | null
  copy: LoanCopyRow
  owner: PublicUserRow
  borrower: PublicUserRow
  /** Лише події `RECOVERED` (≤ 1, M4): решта audit trail цим контрактом не віддається. */
  events: { occurredAt: Date; effectiveAt: Date | null }[]
}

/** Походження позик, які віддає `/loans`. `RECORDED_GUEST` — крок 10f. */
export type ServedOrigin = Extract<LoanOrigin, 'REQUESTED' | 'RECORDED_EXISTING'>

/**
 * Stage 10 (T1, T2): `borrower` і `requestedAt` у БД nullable — гостьові й записані власником
 * позики не мають ні зареєстрованого позичальника, ні запиту. Цей API віддає лише валідні позики
 * request-flow та записані власником між зареєстрованими друзями (10e).
 */
export type StoredLoanRow = Pick<
  LoanModel,
  'requestedAt' | 'borrowerId' | 'origin' | 'borrowerKind' | 'status' | 'handedAt'
> & {
  borrower: PublicUserRow | null
}

export type ServedLoan<T extends StoredLoanRow> = Omit<
  T,
  'requestedAt' | 'borrower' | 'borrowerId' | 'origin'
> & {
  requestedAt: Date | null
  borrower: PublicUserRow
  borrowerId: string
  origin: ServedOrigin
}

/** Статуси, можливі для позики request-flow: статуси запису (`PENDING_CONFIRMATION`, `DECLINED`) їй чужі. */
export const REQUEST_FLOW_STATUSES: readonly LoanStatus[] = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'HANDED_OVER',
  'RETURNED',
  'LOST',
]

/** Статуси, можливі для записаної власником позики: запиту й погодження в ній не буває. */
export const RECORDED_STATUSES: readonly LoanStatus[] = [
  'PENDING_CONFIRMATION',
  'DECLINED',
  'CANCELLED',
  'HANDED_OVER',
  'RETURNED',
  'LOST',
]

/**
 * `null` — позика не віддається цим API: гостьова, або несумісна з власним походженням (синтетичний
 * `RECORDED_EXISTING` зі `status = REQUESTED` чи без `handedAt` не стає легітимним записом).
 */
export function asServedLoan<T extends StoredLoanRow>(row: T): ServedLoan<T> | null {
  if (row.borrowerKind !== 'REGISTERED') return null
  if (row.borrower === null || row.borrowerId === null) return null

  if (row.origin === 'REQUESTED') {
    if (row.requestedAt === null || !REQUEST_FLOW_STATUSES.includes(row.status)) return null

    return { ...row, origin: row.origin, borrower: row.borrower, borrowerId: row.borrowerId }
  }

  // Записана власником позика завжди має фактичну дату передачі; `requestedAt` не вигадується (origin —
  // джерело істини), навіть коли БД дала дефолт `now()`.
  if (row.origin !== 'RECORDED_EXISTING') return null
  if (row.handedAt === null || !RECORDED_STATUSES.includes(row.status)) return null

  return {
    ...row,
    origin: row.origin,
    requestedAt: null,
    borrower: row.borrower,
    borrowerId: row.borrowerId,
  }
}

/**
 * §5.2: «`OVERDUE` — не статус». Прострочення виводиться, а не зберігається:
 * окремий статус довелося б проставляти по крону, і він завжди відставав би на
 * час між запусками.
 *
 * Рахує це сервер, а не клієнт: інакше два пристрої з різними годинниками
 * показували б різне про ту саму книжку.
 */
export function isOverdue(
  loan: Pick<LoanRow, 'status' | 'dueAt'>,
  now: Date = new Date(),
): boolean {
  return (
    loan.status === 'HANDED_OVER' && loan.dueAt !== null && loan.dueAt.getTime() < now.getTime()
  )
}

/**
 * Термін повернення — день без часу, як `Copy.acquiredAt`.
 *
 * У базі лежить кінець доби (див. `toDueDate`), тож на видачу день беремо з UTC —
 * і «до 12 червня» повертається саме 12-м, а не 13-м через локальний зсув.
 */
export function toIsoDay(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

/**
 * День → мить, до якої книжка ще не прострочена.
 *
 * Кінець доби, а не її початок: «до 12 червня» в живій мові означає «12-те ще
 * твоє». З опівніччю людина ставала б боржником зранку того самого дня, який
 * сама ж і назвала.
 */
export function toDueDate(day: string | null | undefined): Date | null {
  return day === undefined || day === null ? null : new Date(`${day}T23:59:59.999Z`)
}

export function toLoan(loan: LoanRow, now: Date = new Date()): Loan {
  const recovery = loan.events[0]

  return {
    id: loan.id,
    status: loan.status,
    isOverdue: isOverdue(loan, now),
    message: loan.message,
    responseNote: loan.responseNote,
    origin: loan.origin,
    createdAt: loan.createdAt.toISOString(),
    requestedAt: loan.requestedAt?.toISOString() ?? null,
    respondedAt: loan.respondedAt?.toISOString() ?? null,
    handedAt: loan.handedAt?.toISOString() ?? null,
    returnedAt: loan.returnedAt?.toISOString() ?? null,
    dueAt: toIsoDay(loan.dueAt),
    owner: toPublicUser(loan.owner),
    borrower: toPublicUser(loan.borrower),
    copy: {
      id: loan.copy.id,
      status: loan.copy.status,
      condition: loan.copy.condition,
      isArchived: loan.copy.archivedAt !== null,
    },
    edition: toEdition(loan.copy.edition),
    work: toWork(loan.copy.edition.work),
    authors: toWorkAuthors(loan.copy.edition.work.authors),
    recovery:
      recovery === undefined
        ? null
        : {
            effectiveAt: (recovery.effectiveAt ?? recovery.occurredAt).toISOString(),
            recordedAt: recovery.occurredAt.toISOString(),
          },
  }
}
