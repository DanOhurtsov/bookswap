import type { LoanStatus } from '../generated/prisma/enums'

/**
 * Stage 10 (10b, Q8; 10j.1, T12): «фактична передача» — єдине визначення для «Хто брав цю книжку»
 * (`GET /works/:id/history`) і для тега `wasBorrowed` в особистому списку читання.
 *
 * `LOST` рахується, лише якщо передача відбулася (`handedAt != null`); решта статусів — запит,
 * відмова або претензія (R-5). Одна константа на обидва місця, щоб предикати не розійшлися.
 */
export const ACTUAL_HANDOVER_STATUSES: readonly LoanStatus[] = ['HANDED_OVER', 'RETURNED', 'LOST']

export const ACTUAL_HANDOVER: { status: { in: LoanStatus[] }; handedAt: { not: null } } = {
  status: { in: [...ACTUAL_HANDOVER_STATUSES] },
  handedAt: { not: null },
}
