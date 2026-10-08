import type {
  GuestConfirmationAction,
  GuestLoanConfirmationStatus,
  LoanStatus,
} from '@bookswap/shared'
import type { WritableLoanEventType } from './loan-event.types'

/**
 * Stage 10 (10i.1): чиста таблиця дій власника над запитом гостьового підтвердження.
 *
 * Не змінює нічого й не звертається до БД: рішення «яка дія з якого стану дозволена і що вона
 * зачіпає» відокремлено від транзакційної обв'язки (`GuestLoanConfirmationService`), як і для
 * `resolveLoanTransition`. Назви станів і подій — технічні деталі, а не затверджені продуктові
 * правила (§0.13 плану).
 *
 * Дозволені лише з незавершених станів `OPEN` (очікуємо відповіді гостя) і `DENIED` («Не отримував»):
 * `RECEIVED`, `CANCELLED` й `OWNER_RECORDED` термінальні. Заперечення гостя саме по собі `Copy` не
 * звільняє (Q25): `Copy` стає `AVAILABLE` лише як наслідок `cancel_handover`.
 *
 * Відповіді гостя (`OPEN → DENIED`, `OPEN → RECEIVED`) — це публічний шлях 10i.2 і тут
 * навмисно відсутні.
 */

/** Стани, з яких власник ще може розв'язати запит. */
export const UNRESOLVED_CONFIRMATION_STATUSES = [
  'OPEN',
  'DENIED',
] as const satisfies readonly GuestLoanConfirmationStatus[]

export interface ConfirmationTransition {
  confirmationTo: Extract<GuestLoanConfirmationStatus, 'CANCELLED' | 'OWNER_RECORDED'>
  loanTo: Extract<LoanStatus, 'CANCELLED' | 'HANDED_OVER'>
  /** `AVAILABLE` — книжка вдома; `LENT_OUT` — тримач лишається контакт. */
  copyTo: 'AVAILABLE' | 'LENT_OUT'
  event: Extract<WritableLoanEventType, 'GUEST_HANDOVER_CANCELLED' | 'GUEST_LOAN_OWNER_RECORDED'>
  /** Чужі `REQUESTED` відхиляються лише при переході до запису зі слів власника (§0.13 п. 3). */
  rejectsRequestedRivals: boolean
}

const CANCEL_HANDOVER: ConfirmationTransition = {
  confirmationTo: 'CANCELLED',
  loanTo: 'CANCELLED',
  copyTo: 'AVAILABLE',
  event: 'GUEST_HANDOVER_CANCELLED',
  rejectsRequestedRivals: false,
}

const RECORD_OWNER_STATEMENT: ConfirmationTransition = {
  confirmationTo: 'OWNER_RECORDED',
  loanTo: 'HANDED_OVER',
  copyTo: 'LENT_OUT',
  event: 'GUEST_LOAN_OWNER_RECORDED',
  rejectsRequestedRivals: true,
}

/** `null` — дія з цього стану неможлива (→ 409 `LOAN_INVALID_TRANSITION`). */
export function resolveConfirmationTransition(
  from: GuestLoanConfirmationStatus,
  action: GuestConfirmationAction,
): ConfirmationTransition | null {
  if (from !== 'OPEN' && from !== 'DENIED') return null

  return action === 'cancel_handover' ? CANCEL_HANDOVER : RECORD_OWNER_STATEMENT
}
