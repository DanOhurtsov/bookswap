import { z } from 'zod'

/**
 * §4.6, enum `LoanStatus`.
 *
 * Значення дублюють Prisma-enum з `apps/api` — причина та сама, що в
 * `domain/visibility.ts`: `packages/shared` не має права залежати від
 * згенерованого клієнта (§12.1). Розсинхрон ловить `enum-parity.spec.ts`.
 *
 * `OVERDUE` тут немає навмисно (§5.2): прострочення виводиться як
 * `status = HANDED_OVER AND dueAt < now()`. Окремий статус довелося б проставляти
 * по крону, і він завжди відставав би від реальності.
 */
export const LOAN_STATUS = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'HANDED_OVER',
  'RETURNED',
  'LOST',
  // Stage 10 (docs/plan/stage-10-real-world-history.md, T3): запис наявної позики власником (10e).
  'PENDING_CONFIRMATION',
  'DECLINED',
] as const

export const loanStatusSchema = z.enum(LOAN_STATUS)

export type LoanStatus = z.infer<typeof loanStatusSchema>

/**
 * Статуси, за яких лоан ще «відкритий»: він або чекає на відповідь, або вже щось
 * означає для примірника. Решта чотири термінальні.
 *
 * Окремий список, а не звуження `LOAN_STATUS` фільтром — він виражає інше
 * питання: не «які статуси бувають», а «чи є зараз між цією людиною й цим
 * примірником щось незавершене». Ним користується §6.5: кнопка «Попросити» не
 * може вирішувати за `Copy.status`, бо `REQUESTED` примірника не змінює.
 */
export const OPEN_LOAN_STATUS = [
  'REQUESTED',
  'APPROVED',
  'HANDED_OVER',
  'PENDING_CONFIRMATION',
] as const

export const openLoanStatusSchema = z.enum(OPEN_LOAN_STATUS)

export type OpenLoanStatus = z.infer<typeof openLoanStatusSchema>

/**
 * Статуси, за яких лоан займає примірник **ексклюзивно**.
 *
 * Рівно та множина, яку тримає частковий унікальний індекс
 * `one_active_loan_per_copy` (§5.3.1), тож такий лоан на примірнику завжди
 * не більше одного. `REQUESTED` сюди не входить: §5.2 навмисно дозволяє кільком
 * людям одночасно мати запит на той самий примірник.
 *
 * Це ж та множина, що блокує видалення примірника й зміну його статусу (§5.2).
 * Stage 10 (M5, 10e): `PENDING_CONFIRMATION` — запис власника, що чекає відповіді, теж займає книжку.
 */
export const EXCLUSIVE_LOAN_STATUS = ['APPROVED', 'HANDED_OVER', 'PENDING_CONFIRMATION'] as const

export const exclusiveLoanStatusSchema = z.enum(EXCLUSIVE_LOAN_STATUS)

export type ExclusiveLoanStatus = z.infer<typeof exclusiveLoanStatusSchema>

/**
 * §8: `PATCH /loans/:id { action }` — один ендпоінт замість переходів §5.1 (і `recover` Етапу 10).
 *
 * Прецедент і мотивація ті самі, що у `FRIEND_REQUEST_ACTIONS`: усі переходи
 * проходять крізь одну точку, де живе валідація стейт-машини. Назви — з §8
 * буквально, у snake_case, бо це значення протоколу, а не імена методів.
 */
export const LOAN_ACTIONS = [
  'approve',
  'reject',
  'cancel',
  'hand_over',
  'return',
  'mark_lost',
  // Stage 10 (10d, T3): `LOST → LOST` + подія `RECOVERED`. Статус позики не змінюється.
  'recover',
  // Stage 10 (10e, T3): запис наявної позики. Лише для `origin = RECORDED_EXISTING`.
  'confirm_record',
  'decline_record',
  'withdraw_record',
  'amend_record',
] as const

export const loanActionSchema = z.enum(LOAN_ACTIONS)

export type LoanAction = z.infer<typeof loanActionSchema>

/**
 * §8: `GET /loans?role=owner|borrower`.
 *
 * Це не роль у системі, а бік конкретного лоану: та сама людина одночасно
 * власник в одних лоанах і позичальник в інших, тож фільтр мусить бути явним.
 */
export const LOAN_ROLES = ['owner', 'borrower'] as const

export const loanRoleSchema = z.enum(LOAN_ROLES)

export type LoanRole = z.infer<typeof loanRoleSchema>

/**
 * Stage 10 (T1): чи позичальник — зареєстрований користувач, чи гість-контакт (D1).
 * Дзеркало Prisma-enum; розсинхрон ловить `enum-parity.spec.ts`.
 */
export const BORROWER_KIND = ['REGISTERED', 'GUEST'] as const

export const borrowerKindSchema = z.enum(BORROWER_KIND)

export type BorrowerKind = z.infer<typeof borrowerKindSchema>

/** Stage 10 (T1): звідки взявся `Loan` — запит, записана власником наявна позика чи гостьова. */
export const LOAN_ORIGIN = ['REQUESTED', 'RECORDED_EXISTING', 'RECORDED_GUEST'] as const

export const loanOriginSchema = z.enum(LOAN_ORIGIN)

export type LoanOrigin = z.infer<typeof loanOriginSchema>

/**
 * Stage 10 (T4): типи подій audit trail. Значення `LINK_*` додасть крок 10i.
 *
 * `LOSS_CLOSED` (10f.3, T7b): власник закрив питання втрати гостьової позики без факту
 * повернення чи знахідки — окремо від `RECOVERED`, і не взаємовиключне з ним (§6.11.1: `recover`
 * дозволений і після `LOSS_CLOSED`, Q3c).
 */
export const LOAN_EVENT_TYPE = [
  'RECORD_PROPOSED',
  'RECORD_AMENDED',
  'RECORD_CONFIRMED',
  'RECORD_DECLINED',
  'RECORD_WITHDRAWN',
  'GUEST_LOAN_RECORDED',
  'LOAN_RETURNED',
  'LOAN_LOST',
  'RECOVERED',
  'LOSS_CLOSED',
] as const

export const loanEventTypeSchema = z.enum(LOAN_EVENT_TYPE)

export type LoanEventType = z.infer<typeof loanEventTypeSchema>

/**
 * Stage 10 (10f.3): переходи гостьової позики — `PATCH /loans/guest/:id { action }`.
 *
 * Окремий, вужчий словник від `LOAN_ACTIONS`: гостьова позика не має ні запиту, ні підтвердження
 * від другої сторони (гість без акаунта), тож дії request-flow й запису (`approve`, `confirm_record`
 * тощо) для неї синтаксично неможливі — це виключає їх на рівні DTO, а не лише в чистій функції
 * переходів. `close_loss` — тут і тільки тут (T7b, §6.11.1): дія стосується виключно гостьових
 * `LOST`-позик, для яких немає власника контакту, окрім самого власника примірника.
 */
export const GUEST_LOAN_ACTIONS = ['return', 'mark_lost', 'recover', 'close_loss'] as const

export const guestLoanActionSchema = z.enum(GUEST_LOAN_ACTIONS)

export type GuestLoanAction = z.infer<typeof guestLoanActionSchema>
