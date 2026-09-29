import { z } from 'zod'
import type { PreferenceChannel } from './channel'

/**
 * §4.8, enum `NotificationType`.
 *
 * Значення дублюють Prisma-enum — причина та сама, що в `domain/visibility.ts`.
 * Парність тримає `apps/api/src/common/enum-parity.spec.ts`.
 *
 * **`LOAN_CANCELLED` — свідоме доповнення до §4.8.** §5.1 для переходу
 * `APPROVED → CANCELLED` вимагає «сповіщення другій стороні», але типу під нього
 * в §4.8 немає. Переприсвоїти `LOAN_REJECTED` не можна: «вам відмовили» і
 * «домовленість скасовано» — різні події, і на етапі 3 різниця поїде в текст
 * листа й повідомлення в Telegram. Деталі — в README.
 *
 * `REQUESTED → CANCELLED` і `HANDED_OVER → LOST` сповіщень не породжують: у §5.1
 * ці рядки мають порожню клітинку побічних ефектів, і це не пропуск.
 */
export const NOTIFICATION_TYPE = [
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'LOAN_CANCELLED',
  'LOAN_HANDED_OVER',
  'LOAN_RETURNED',
  'LOAN_DUE_SOON',
  'LOAN_OVERDUE',
  'FRIEND_REQUESTED',
  'FRIEND_ACCEPTED',
  // Stage 10 (10e): життєвий цикл запису наявної позики.
  'LOAN_RECORD_PROPOSED',
  'LOAN_RECORD_CONFIRMED',
  'LOAN_RECORD_DECLINED',
  'LOAN_RECORD_WITHDRAWN',
  'LOAN_RECORD_AMENDED',
  // Stage 10 (10i.3): відповідь гостя на запит підтвердження конкретної позики. IN_APP + загальний EMAIL за правилами власника; Telegram недоступний.
  'GUEST_LOAN_RECEIVED',
  'GUEST_LOAN_DENIED',
] as const

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPE)

export type NotificationType = z.infer<typeof notificationTypeSchema>

/**
 * §7.5, перша група: надсилається негайно, щойно подія сталася.
 *
 * Це рівно ті типи, які породжують переходи §5.1 і дружба §6.2 — тобто ті, що
 * створюються в транзакції разом зі зміною стану.
 */
export const IMMEDIATE_NOTIFICATION_TYPE = [
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'LOAN_CANCELLED',
  'LOAN_HANDED_OVER',
  'LOAN_RETURNED',
  'FRIEND_REQUESTED',
  'FRIEND_ACCEPTED',
  // Stage 10 (10e): життєвий цикл запису наявної позики.
  'LOAN_RECORD_PROPOSED',
  'LOAN_RECORD_CONFIRMED',
  'LOAN_RECORD_DECLINED',
  'LOAN_RECORD_WITHDRAWN',
  'LOAN_RECORD_AMENDED',
  // Stage 10 (10i.3): створюються в транзакції відповіді гостя.
  'GUEST_LOAN_RECEIVED',
  'GUEST_LOAN_DENIED',
] as const

/**
 * Stage 10 (10i.3): відповіді гостя на запит підтвердження позики.
 *
 * Рішення PO (forward-запис у плані): власник отримує IN_APP з результатом; EMAIL доступний за звичайними
 * правилами (підтверджена адреса, налаштування власника) і ввімкнений за замовчуванням, але лист лише
 * ЗАГАЛЬНИЙ (без книжки, результату, нікнейма, email гостя, alias чи id запиту — див. renderer);
 * TELEGRAM для цих типів недоступний ніколи: ні за замовчуванням, ні за явним налаштуванням, ні за
 * прив'язаним чатом.
 */
export const GUEST_RESPONSE_NOTIFICATION_TYPE = [
  'GUEST_LOAN_RECEIVED',
  'GUEST_LOAN_DENIED',
] as const

export type GuestResponseNotificationType = (typeof GUEST_RESPONSE_NOTIFICATION_TYPE)[number]

export function isGuestResponseNotificationType(
  type: NotificationType,
): type is GuestResponseNotificationType {
  return (GUEST_RESPONSE_NOTIFICATION_TYPE as readonly NotificationType[]).includes(type)
}

/**
 * §7.5, друга група: тільки щоденним дайджестом.
 *
 * «Другу групу не можна дозволяти надсилати негайно: активний користувач
 * перетворить бота на спам, і його вимкнуть разом із важливими сповіщеннями.»
 * Розділення тут не декоративне — воно каже, **хто** має право створювати ці
 * рядки: не стейт-машина, а щоденна задача. `Loan.status` при цьому не
 * змінюється (§5.2: «`OVERDUE` — не статус»).
 */
export const DIGEST_NOTIFICATION_TYPE = ['LOAN_DUE_SOON', 'LOAN_OVERDUE'] as const

export type DigestNotificationType = (typeof DIGEST_NOTIFICATION_TYPE)[number]

/**
 * §7.6: «критичне для флоу — в EMAIL».
 *
 * Критичне — це те, де без дії людини нічого не рухається: запит чекає на
 * відповідь, погоджену книжку треба забрати, прострочену — повернути. Підтвердження
 * доконаного факту (`HANDED_OVER`, `RETURNED`, `FRIEND_ACCEPTED`) сюди не входять:
 * вони нікого ні до чого не зобов'язують, і лист про них — це той зайвий лист,
 * після якого вимикають усі.
 */
export const FLOW_CRITICAL_NOTIFICATION_TYPE = [
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'LOAN_CANCELLED',
  'LOAN_DUE_SOON',
  'LOAN_OVERDUE',
  'FRIEND_REQUESTED',
  // Stage 10 (10e): без відповіді позичальника запис не рухається (виправлення дат — так само).
  'LOAN_RECORD_PROPOSED',
  'LOAN_RECORD_AMENDED',
] as const

/** Чи створюється тип щоденною задачею, а не переходом стану. */
export function isDigestNotificationType(type: NotificationType): type is DigestNotificationType {
  return (DIGEST_NOTIFICATION_TYPE as readonly NotificationType[]).includes(type)
}

/**
 * §7.6, дефолти матриці «тип × канал» для клітинки, якої немає в базі.
 *
 * Значення обчислюється, а не матеріалізується рядками при реєстрації, і це
 * свідомо: 10 типів × 3 канали = 30 рядків на кожного користувача, які довелося
 * б доливати міграцією щоразу, коли з'являється новий тип події чи новий канал.
 * Відсутність рядка означає «як за замовчуванням», а не «вимкнено».
 *
 * Функція живе в `shared`, бо відповідь на неї потрібна з обох боків: `apps/api`
 * вирішує нею, які `NotificationDelivery` створювати, а `apps/web` — у якому
 * стані малювати перемикач, якого користувач ще не чіпав. Дві копії цієї
 * політики розійшлися б на першому ж новому типі.
 */
export function defaultPreferenceEnabled(
  type: NotificationType,
  channel: PreferenceChannel,
  context: { telegramLinked: boolean },
): boolean {
  // §7.6: «Дефолти: усе в IN_APP». Вимкнути його можна, але не за замовчуванням:
  // без жодного каналу подія була б невидимою навіть на власній сторінці.
  if (channel === 'IN_APP') return true

  // «після підключення Telegram — усе в TELEGRAM». До підключення надсилати нікуди. Відповіді гостя
  // (`GUEST_RESPONSE_NOTIFICATION_TYPE`) — виняток: Telegram для них недоступний.
  if (channel === 'TELEGRAM')
    return context.telegramLinked && !isGuestResponseNotificationType(type)

  // EMAIL: критичне для флоу + відповіді гостя (лист загальний, див. renderer).
  return (
    isGuestResponseNotificationType(type) ||
    (FLOW_CRITICAL_NOTIFICATION_TYPE as readonly NotificationType[]).includes(type)
  )
}
