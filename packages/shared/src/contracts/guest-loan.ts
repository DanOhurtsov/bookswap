import { z } from 'zod'
import { guestLoanActionSchema, loanStatusSchema } from '../domain/loan'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { externalBorrowerAliasSchema } from './external-borrower'
import { LOAN_LIMITS, loanCopySchema, loanRecoverySchema } from './loan'

/**
 * Stage 10, крок 10f.3: гостьова позика (`origin = RECORDED_GUEST`).
 *
 * Окремий, вужчий контракт від `loanSchema` (D1–D4):
 * - жодного `owner`/`borrower`-об'єкта користувача: власник відомий із сесії (маршрут owner-only),
 *   позичальника-акаунта не існує;
 * - `contact` — єдине місце в усьому API, окрім `/me/external-borrowers`, де віддається alias, і лише
 *   тут він з'являється РАЗОМ із фактом конкретної позики; `null` — контакт стерто (D3/Q3d), факт
 *   позики (дати, статус, copy) лишається;
 * - жодного `message`/`note`: вільний текст для гостя заборонений (D1);
 * - `requestedAt` немає взагалі: гостьова позика ніколи не має запиту (`origin` — не `REQUESTED`).
 *
 * Ця схема НІКОЛИ не з'являється в спільних відповідях (`/loans`, `/works/:id/history`,
 * `/copies/:id/history`, `/me/history`) — там гостьовий факт лишається анонімним за `historyEntrySchema`
 * (P1/P2). Джерело істини про owner-only доступ — маршрут (`GuestLoansController`), не поле.
 */

export const guestLoanContactSchema = z
  .strictObject({
    id: z.string(),
    alias: externalBorrowerAliasSchema,
  })
  .nullable()

export type GuestLoanContact = z.infer<typeof guestLoanContactSchema>

/**
 * Stage 10 (10f.3, T7b): факт закриття втрати дією власника «Закрити втрату» — окремо від
 * `loanRecoverySchema` (`RECOVERED`), і не взаємовиключний з ним (Q3c). На відміну від `recovery`,
 * тут немає `effectiveAt`: клієнтська дата закриття не приймається (§6.11.1) — лише серверний момент.
 */
export const guestLoanLossClosureSchema = z.strictObject({
  recordedAt: z.iso.datetime(),
})

export type GuestLoanLossClosure = z.infer<typeof guestLoanLossClosureSchema>

export const guestLoanSchema = z.strictObject({
  id: z.string(),
  /** Гостьова позика ніколи не буває `REQUESTED`/`APPROVED`/`PENDING_CONFIRMATION`/`DECLINED`. */
  status: loanStatusSchema.extract(['HANDED_OVER', 'RETURNED', 'LOST']),
  isOverdue: z.boolean(),
  createdAt: z.iso.datetime(),
  handedAt: z.iso.datetime(),
  returnedAt: z.iso.datetime().nullable(),
  dueAt: z.iso.date().nullable(),
  copy: loanCopySchema,
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  /** `null` після `DELETE` контакту (D3/Q3d) — факт позики лишається, alias зникає разом із контактом. */
  contact: guestLoanContactSchema,
  /** `null`, доки знахідку не зафіксовано (і завжди для не-`LOST` позик). */
  recovery: loanRecoverySchema.nullable(),
  /** `null`, доки власник не закрив питання втрати вручну (і завжди для не-`LOST` позик). */
  lossClosure: guestLoanLossClosureSchema.nullable(),
})

export type GuestLoan = z.infer<typeof guestLoanSchema>

// --- Запити -------------------------------------------------------------------

const guestLoanDateSchema = z.iso.date()

/**
 * Stage 10 (10f.3): `POST /loans/guest { copyId, externalBorrowerId, handedAt, dueAt? }`.
 *
 * Дзеркалить `createRecordedLoanRequestSchema`, але без `borrowerId` (тут — контакт, не користувач).
 */
export const createGuestLoanRequestSchema = z
  .strictObject({
    copyId: z.string().trim().min(1).max(LOAN_LIMITS.idMax),
    externalBorrowerId: z.string().trim().min(1).max(LOAN_LIMITS.idMax),
    handedAt: guestLoanDateSchema,
    dueAt: guestLoanDateSchema.optional(),
  })
  .refine(
    (value) => value.dueAt === undefined || value.dueAt >= value.handedAt,
    'Строк повернення не може бути раніше дати передачі',
  )

export type CreateGuestLoanRequest = z.infer<typeof createGuestLoanRequestSchema>

/**
 * Stage 10 (10f.3): `PATCH /loans/guest/:id { action, effectiveAt? }`.
 *
 * `effectiveAt` — лише з `recover` (дата знахідки, як у `updateLoanRequestSchema`); `close_loss` дати
 * від клієнта не приймає (§6.11.1) навмисно.
 */
export const updateGuestLoanRequestSchema = z
  .strictObject({
    action: guestLoanActionSchema,
    effectiveAt: guestLoanDateSchema.optional(),
  })
  .refine(
    (value) => value.effectiveAt === undefined || value.action === 'recover',
    'Дату знахідки можна вказати лише разом із дією recover',
  )

export type UpdateGuestLoanRequest = z.infer<typeof updateGuestLoanRequestSchema>

// --- Відповіді ----------------------------------------------------------------

export const guestLoanResponseSchema = z.strictObject({ loan: guestLoanSchema })

export type GuestLoanResponse = z.infer<typeof guestLoanResponseSchema>

export const guestLoanListResponseSchema = z.strictObject({ loans: z.array(guestLoanSchema) })

export type GuestLoanListResponse = z.infer<typeof guestLoanListResponseSchema>
