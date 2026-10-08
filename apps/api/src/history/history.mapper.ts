import {
  guestLoanEvidenceOf,
  type GuestLoanConfirmationStatus,
  type HistoryCopy,
  type HistoryEntry,
  type NamedHistoryEntry,
} from '@bookswap/shared'
import {
  toEdition,
  toWork,
  toWorkAuthors,
  type EditionRow,
  type WorkAuthorRow,
  type WorkRow,
} from '../catalog/catalog.mapper'
import { isOverdue, toIsoDay } from '../loans/loan.mapper'
import { toPublicUser, type PublicUserRow } from '../users/user.mapper'
import type { CopyModel, LoanModel } from '../generated/prisma/models'

/**
 * §6.6: історія виводиться з `Loan` — окремих таблиць немає (§4.6).
 *
 * Проєкцій дві, і це та сама вимога, що вже дала три проєкції `Copy`: §9 каже, що
 * приватне не повинно **віддаватися з API**, а не ховатися в UI. Єдиний надійний
 * спосіб це гарантувати — щоб полів з іменами у відповідній функції не існувало
 * взагалі.
 *
 * Одна функція з прапорцем `showNames` виглядала б коротшою й була б гіршою:
 * досить забути занулити одне вкладене поле — і ім'я поїде тому, кому §6.6 його
 * не обіцяла. Тут забути нічого: `toAnonymousEntry` фізично не має доступу до
 * користувачів, бо не приймає їх у результат.
 *
 * `showNames` вирішує не цей файл, а `holderNamesVisibleTo` зі §9 — сюди приїжджає
 * вже готова відповідь.
 */

export type HistoryLoanRow = Pick<
  LoanModel,
  | 'id'
  | 'status'
  | 'origin'
  | 'createdAt'
  | 'requestedAt'
  | 'respondedAt'
  | 'handedAt'
  | 'returnedAt'
  | 'dueAt'
> & {
  owner: PublicUserRow
  /**
   * Stage 10 (T1): `null` для гостьової позики. Гостя бачить лише власник і лише з кроку 10f
   * (D4); до того — і тут, і для всіх — запис анонімний.
   */
  borrower: PublicUserRow | null
  /**
   * Stage 10 (10i.1): лише `status` рядка підтвердження — з нього виводиться джерело доказу. Жодного
   * alias/нікнейма/email тут немає й бути не може.
   */
  guestConfirmation: { status: GuestLoanConfirmationStatus } | null
}

/** Позика із зареєстрованим позичальником — єдина, що має іменовану проєкцію до кроку 10f. */
export type NamedHistoryLoanRow = HistoryLoanRow & { borrower: PublicUserRow }

export function hasRegisteredBorrower<T extends HistoryLoanRow>(
  loan: T,
): loan is T & NamedHistoryLoanRow {
  return loan.borrower !== null
}

export type HistoryCopyRow = Pick<CopyModel, 'id' | 'status' | 'condition'> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
}

/** Самі факти: статуси й дати. Жодного носія особи. */
function factsOf(
  loan: HistoryLoanRow,
  now: Date,
): Omit<NamedHistoryEntry, 'names' | 'loanId' | 'owner' | 'borrower'> {
  return {
    status: loan.status,
    origin: loan.origin,
    guestEvidence:
      loan.origin === 'RECORDED_GUEST'
        ? guestLoanEvidenceOf(loan.guestConfirmation?.status ?? null)
        : null,
    isOverdue: isOverdue(loan, now),
    requestedAt: loan.requestedAt?.toISOString() ?? null,
    respondedAt: loan.respondedAt?.toISOString() ?? null,
    handedAt: loan.handedAt?.toISOString() ?? null,
    returnedAt: loan.returnedAt?.toISOString() ?? null,
    dueAt: toIsoDay(loan.dueAt),
  }
}

/** §6.6: власнику завжди, другові — за `showHolderNames`. */
export function toNamedEntry(loan: NamedHistoryLoanRow, now: Date = new Date()): NamedHistoryEntry {
  return {
    ...factsOf(loan, now),
    names: true,
    loanId: loan.id,
    owner: toPublicUser(loan.owner),
    borrower: toPublicUser(loan.borrower),
  }
}

/**
 * §6.6: «у когось до 12 червня».
 *
 * `loanId` теж не віддається. Дій над чужим лоаном немає (`GET /loans/:id`
 * відповість 404), тож id був би рівно тим ідентифікатором, за яким два різні
 * зрізи анонімної історії склеюються в одну людину.
 */
export function toAnonymousEntry(loan: HistoryLoanRow, now: Date = new Date()): HistoryEntry {
  return { ...factsOf(loan, now), names: false }
}

export function toHistoryEntry(
  loan: HistoryLoanRow,
  showNames: boolean,
  now: Date = new Date(),
): HistoryEntry {
  return showNames && hasRegisteredBorrower(loan)
    ? toNamedEntry(loan, now)
    : toAnonymousEntry(loan, now)
}

/**
 * Примірник у контексті історії.
 *
 * Ані `ownerId`, ані `currentHolderId`, ані вкладеного власника — та сама вимога
 * §6.6, застосована до обгортки. Чия це полиця, викликач знає зі сторінки, з якої
 * прийшов; id у тілі відповіді був би каналом витоку рівно тоді, коли імена
 * приховані.
 */
export function toHistoryCopy(copy: HistoryCopyRow): HistoryCopy {
  return {
    id: copy.id,
    status: copy.status,
    condition: copy.condition,
    edition: toEdition(copy.edition),
    work: toWork(copy.edition.work),
    authors: toWorkAuthors(copy.edition.work.authors),
  }
}

/** Хронологія §6.6: від найдавнішого запиту до найновішого. */
export function byRequestedAt(one: HistoryLoanRow, other: HistoryLoanRow): number {
  return (
    (one.requestedAt ?? one.createdAt).getTime() -
      (other.requestedAt ?? other.createdAt).getTime() || one.id.localeCompare(other.id)
  )
}
