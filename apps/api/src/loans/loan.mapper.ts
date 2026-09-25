import type { Loan } from '@bookswap/shared'
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

export type LoanCopyRow = Pick<CopyModel, 'id' | 'status' | 'condition'> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
}

export type LoanRow = Pick<
  LoanModel,
  'id' | 'status' | 'message' | 'responseNote' | 'respondedAt' | 'handedAt' | 'returnedAt' | 'dueAt'
> & {
  requestedAt: Date
  copy: LoanCopyRow
  owner: PublicUserRow
  borrower: PublicUserRow
}

/**
 * Stage 10 (T1, T2): `borrower` і `requestedAt` у БД nullable — гостьові й записані власником
 * позики не мають ні зареєстрованого позичальника, ні запиту. Цей API віддає лише позики
 * request-flow; решта отримає власні контракти в кроках 10e/10f.
 */
export type StoredLoanRow = Pick<
  LoanModel,
  'requestedAt' | 'borrowerId' | 'origin' | 'borrowerKind'
> & {
  borrower: PublicUserRow | null
}

export type RequestFlowLoan<T extends StoredLoanRow> = Omit<
  T,
  'requestedAt' | 'borrower' | 'borrowerId'
> & { requestedAt: Date; borrower: PublicUserRow; borrowerId: string }

/**
 * `null` — позика не з request-flow (гостьова чи записана власником): вона не
 * представляється в `LoanResponse`, тож для цього API її «не існує».
 */
export function asRequestFlowLoan<T extends StoredLoanRow>(row: T): RequestFlowLoan<T> | null {
  // Межа визначається походженням і видом позичальника, а не лише «випадковою» ненульовістю полів:
  // записана власником позика із зареєстрованим позичальником теж має `requestedAt` (дефолт БД).
  if (row.origin !== 'REQUESTED' || row.borrowerKind !== 'REGISTERED') return null
  if (row.borrower === null || row.borrowerId === null || row.requestedAt === null) return null

  return {
    ...row,
    borrower: row.borrower,
    borrowerId: row.borrowerId,
    requestedAt: row.requestedAt,
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
  return {
    id: loan.id,
    status: loan.status,
    isOverdue: isOverdue(loan, now),
    message: loan.message,
    responseNote: loan.responseNote,
    requestedAt: loan.requestedAt.toISOString(),
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
    },
    edition: toEdition(loan.copy.edition, loan.copy.edition.work),
    work: toWork(loan.copy.edition.work),
    authors: toWorkAuthors(loan.copy.edition.work.authors),
  }
}
