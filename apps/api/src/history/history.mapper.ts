import {
  guestLoanEvidenceOf,
  type GuestLoanConfirmationStatus,
  type HistoryCopy,
  type HistoryEntry,
  type LoanEventType,
  type LoanStatus,
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
import type { CopyModel, LoanEventModel, LoanModel } from '../generated/prisma/models'

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

/** Only what dates a fact: no payload, no actor. */
export type DatedEventRow = Pick<LoanEventModel, 'type' | 'occurredAt' | 'effectiveAt'>

type CompletionSource =
  { column: 'returnedAt' | 'respondedAt' } | { events: readonly LoanEventType[] } | null

/**
 * BS-142: where the ending of a loan in each status is recorded. The one table for `completedAt`
 * (docs/plan/bs-142-unified-loan-history.md, «Джерела дат»).
 *
 * `CANCELLED` of a request has no source on purpose: the `cancel` transition stamps nothing and
 * writes no event, so its ending is unknown rather than guessed. The same goes for an old `LOST`
 * loan without `LOAN_LOST` — `RECOVERED` is not an ending, the status stays `LOST`.
 */
const COMPLETION_SOURCE: Readonly<Record<LoanStatus, CompletionSource>> = {
  RETURNED: { column: 'returnedAt' },
  REJECTED: { column: 'respondedAt' },
  CANCELLED: { events: ['RECORD_WITHDRAWN', 'GUEST_HANDOVER_CANCELLED'] },
  DECLINED: { events: ['RECORD_DECLINED'] },
  LOST: { events: ['LOAN_LOST'] },
  REQUESTED: null,
  APPROVED: null,
  HANDED_OVER: null,
  PENDING_CONFIRMATION: null,
}

/** Every event type `completedAtOf` reads. */
export const COMPLETION_EVENT_TYPES: readonly LoanEventType[] = [
  ...new Set(
    Object.values(COMPLETION_SOURCE).flatMap((source) =>
      source !== null && 'events' in source ? source.events : [],
    ),
  ),
]

/**
 * Facts after the handover that no column records: `recover` keeps the loan `LOST` and stamps
 * nothing (loan.transitions), so the recovery is dated only by its event.
 */
const LATER_FACT_EVENT_TYPES: readonly LoanEventType[] = ['RECOVERED']

/** Every event type the personal history reads — the filter for the query that loads them. */
export const HISTORY_DATE_EVENT_TYPES: readonly LoanEventType[] = [
  ...COMPLETION_EVENT_TYPES,
  ...LATER_FACT_EVENT_TYPES,
]

// `effectiveAt` is the actual date when it differs from the moment of writing (schema docs).
function eventDateOf(event: DatedEventRow): Date {
  return event.effectiveAt ?? event.occurredAt
}

export function completedAtOf(
  loan: Pick<LoanModel, 'status' | 'returnedAt' | 'respondedAt'> & {
    events: DatedEventRow[]
  },
): Date | null {
  const source = COMPLETION_SOURCE[loan.status]

  if (source === null) return null
  if ('column' in source) return loan[source.column]

  return latestOf(
    loan.events.filter((event) => source.events.includes(event.type)).map(eventDateOf),
  )
}

/**
 * BS-142: the latest reliably dated fact of a loan — what orders the loans whose ending is unknown.
 * The request counts only for a real request: a recorded loan's `requestedAt` is a DB default.
 * `dueAt` is a plan and `createdAt` the moment of writing — neither is a fact, neither is used.
 */
export function latestFactAtOf(
  loan: Pick<
    LoanModel,
    'status' | 'origin' | 'requestedAt' | 'respondedAt' | 'handedAt' | 'returnedAt'
  > & { events: DatedEventRow[] },
): Date | null {
  return latestOf([
    loan.origin === 'REQUESTED' ? loan.requestedAt : null,
    loan.respondedAt,
    loan.handedAt,
    loan.returnedAt,
    completedAtOf(loan),
    ...loan.events.filter((event) => LATER_FACT_EVENT_TYPES.includes(event.type)).map(eventDateOf),
  ])
}

function latestOf(dates: (Date | null)[]): Date | null {
  const times = dates.flatMap((date) => (date === null ? [] : [date.getTime()]))

  return times.length === 0 ? null : new Date(Math.max(...times))
}

/** Хронологія §6.6: від найдавнішого запиту до найновішого. */
export function byRequestedAt(one: HistoryLoanRow, other: HistoryLoanRow): number {
  return (
    (one.requestedAt ?? one.createdAt).getTime() -
      (other.requestedAt ?? other.createdAt).getTime() || one.id.localeCompare(other.id)
  )
}
