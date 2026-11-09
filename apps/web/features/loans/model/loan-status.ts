import { LOAN_STATUS, OPEN_LOAN_STATUS, type LoanStatus } from '@bookswap/shared'
import { LOAN_STATUS_LABELS } from '@/app/lib/labels'

/**
 * BS-153: how «Позичання» shows a loan's state. Not a new status: `OVERDUE` stands for the server's
 * own `isOverdue` (§5.2, `HANDED_OVER` past `dueAt`), which the canvas draws as a status of its own.
 * A row's badge and the status filter both read `shownStatusOf`, so «На руках» in the filter finds
 * exactly the rows that say «На руках».
 */
export const OVERDUE = 'OVERDUE'

export type ShownStatus = LoanStatus | typeof OVERDUE

export const OVERDUE_LABEL = 'Прострочено'

export function shownStatusOf(loan: { status: LoanStatus; isOverdue: boolean }): ShownStatus {
  return loan.isOverdue ? OVERDUE : loan.status
}

/** The one split between the current tabs and «Історія»: `OPEN_LOAN_STATUS`, nothing listed here. */
export function isOpenStatus(status: LoanStatus): boolean {
  return OPEN_LOAN_STATUS.some((open) => open === status)
}

/** What the current tabs can show (PO, 05.11.2026): the open statuses and the overdue among them. */
export const CURRENT_STATUS_FILTERS: readonly ShownStatus[] = [...OPEN_LOAN_STATUS, OVERDUE]

/** What «Історія» can be filtered by: every status that ends a loan. */
export const HISTORY_STATUS_FILTERS: readonly ShownStatus[] = LOAN_STATUS.filter(
  (status) => !isOpenStatus(status),
)

export function shownStatusLabel(status: ShownStatus): string {
  return status === OVERDUE ? OVERDUE_LABEL : LOAN_STATUS_LABELS[status]
}

/** The canvas badge colours: waiting, agreed, on hand, a problem, over. */
export type BadgeTone = 'wait' | 'agreed' | 'hold' | 'over' | 'done'

/** A `switch` without `default`: a new status must pick its colour here or break the build. */
export function badgeToneOf(status: ShownStatus): BadgeTone {
  switch (status) {
    case 'REQUESTED':
    case 'PENDING_CONFIRMATION':
      return 'wait'
    case 'APPROVED':
      return 'agreed'
    case 'HANDED_OVER':
      return 'hold'
    case OVERDUE:
    case 'LOST':
      return 'over'
    case 'RETURNED':
    case 'REJECTED':
    case 'CANCELLED':
    case 'DECLINED':
      return 'done'
  }
}

/**
 * What a status means, for the badge's tooltip. Only what the product does (§5.1, Stage 10): the
 * borrower confirms a receipt, the owner marks a return, and nothing here promises a reminder, an
 * extension or a notification. A switch without `default`, as above.
 */
export function statusExplanationOf(status: ShownStatus): string {
  switch (status) {
    case 'REQUESTED':
      return 'Запит надіслано, власник ще не відповів.'
    case 'APPROVED':
      return 'Власник погодив запит. Позичальник підтверджує, коли отримає книжку.'
    case 'HANDED_OVER':
      return 'Книжка в позичальника. Повернення позначає власник.'
    case OVERDUE:
      return 'Строк повернення минув, а повернення ще не позначено.'
    case 'PENDING_CONFIRMATION':
      return 'Власник записав, що передав книжку. Позичальник має підтвердити або відхилити запис.'
    case 'RETURNED':
      return 'Власник позначив, що книжка повернулася. Позику завершено.'
    case 'REJECTED':
      return 'Власник відмовив у запиті.'
    case 'CANCELLED':
      return 'Позику скасовано: запит, домовленість чи запис більше не діють.'
    case 'DECLINED':
      return 'Позичальник відхилив запис власника.'
    case 'LOST':
      return 'Власник позначив книжку втраченою.'
  }
}
