import { z } from 'zod'
import {
  guestConfirmationActionSchema,
  guestLoanConfirmationStatusSchema,
  guestLoanEvidenceSchema,
  loanStatusSchema,
} from '../domain/loan'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { externalBorrowerAliasSchema } from './external-borrower'
import { createGuestLoanRequestSchema } from './guest-loan'
import { loanCopySchema } from './loan'

/**
 * Stage 10, крок 10i.1: owner-only ресурс запиту гостьового підтвердження
 * (`/api/v1/guest-loan-confirmations`, за `GuestLoansEnabledGuard`; лише синтетичні дані — D2).
 *
 * Окремий від `guestLoanSchema` (10f.3) контракт: очікувані (`PENDING_CONFIRMATION`) і скасовані
 * (`CANCELLED`) запити читаються ТІЛЬКИ тут, а не «випадково» через старий `/loans/guest`. Публічних
 * маршрутів гостя, посилань, токенів і email-коду в 10i.1 немає.
 *
 * Приватність: `contact` несе alias власника й підтверджені гостем нікнейм/email — лише для власника
 * контакту. Ці поля не потрапляють ні в `/loans`, ні в історії (`historyEntrySchema`), ні в публічні
 * відповіді. Назви станів — технічні деталі, а не затверджені продуктові правила (§0.13).
 */

export const guestConfirmationContactSchema = z
  .strictObject({
    id: z.string(),
    alias: externalBorrowerAliasSchema,
    guestNickname: z.string().nullable(),
    guestEmail: z.string().nullable(),
    guestEmailVerifiedAt: z.iso.datetime().nullable(),
  })
  .nullable()

export type GuestConfirmationContact = z.infer<typeof guestConfirmationContactSchema>

export const guestConfirmationLoanSchema = z.strictObject({
  id: z.string(),
  status: loanStatusSchema.extract([
    'PENDING_CONFIRMATION',
    'CANCELLED',
    'HANDED_OVER',
    'RETURNED',
    'LOST',
  ]),
  isOverdue: z.boolean(),
  createdAt: z.iso.datetime(),
  handedAt: z.iso.datetime(),
  returnedAt: z.iso.datetime().nullable(),
  dueAt: z.iso.date().nullable(),
})

export type GuestConfirmationLoan = z.infer<typeof guestConfirmationLoanSchema>

export const guestLoanConfirmationSchema = z.strictObject({
  id: z.string(),
  status: guestLoanConfirmationStatusSchema,
  /** Виводиться з `status` (не зберігається); `null` для скасованої передачі. */
  evidence: guestLoanEvidenceSchema.nullable(),
  createdAt: z.iso.datetime(),
  /** `null`, поки статус `OPEN`/`DENIED`. */
  resolvedAt: z.iso.datetime().nullable(),
  loan: guestConfirmationLoanSchema,
  copy: loanCopySchema,
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  /** `null` після видалення контакту (D3/ручний `DELETE`): рядок і позика лишаються. */
  contact: guestConfirmationContactSchema,
})

export type GuestLoanConfirmation = z.infer<typeof guestLoanConfirmationSchema>

// --- Запити -------------------------------------------------------------------

/** `POST /guest-loan-confirmations` — ті самі поля, що й ручний `POST /loans/guest`. */
export const createGuestLoanConfirmationRequestSchema = createGuestLoanRequestSchema

export type CreateGuestLoanConfirmationRequest = z.infer<
  typeof createGuestLoanConfirmationRequestSchema
>

/**
 * `PATCH /guest-loan-confirmations/:id`. Скасування вимагає явної заяви власника, що книжка фізично в
 * нього (`bookIsWithOwner: true`), — так само, як D2 вимагає `ownerInformed: true`.
 */
export const updateGuestLoanConfirmationRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: guestConfirmationActionSchema.extract(['cancel_handover']),
    bookIsWithOwner: z.literal(true, { error: 'Потрібна заява власника, що книжка в нього' }),
  }),
  z.strictObject({
    action: guestConfirmationActionSchema.extract(['record_owner_statement']),
  }),
])

export type UpdateGuestLoanConfirmationRequest = z.infer<
  typeof updateGuestLoanConfirmationRequestSchema
>

// --- Відповіді ----------------------------------------------------------------

export const guestLoanConfirmationResponseSchema = z.strictObject({
  confirmation: guestLoanConfirmationSchema,
})

export type GuestLoanConfirmationResponse = z.infer<typeof guestLoanConfirmationResponseSchema>

export const guestLoanConfirmationListResponseSchema = z.strictObject({
  confirmations: z.array(guestLoanConfirmationSchema),
})

export type GuestLoanConfirmationListResponse = z.infer<
  typeof guestLoanConfirmationListResponseSchema
>
