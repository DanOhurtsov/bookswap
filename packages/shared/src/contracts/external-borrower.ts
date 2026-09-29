import { z } from 'zod'
import { invitationSchema } from './invitation'
import { emailSchema } from './user'

/**
 * Stage 10, крок 10f.2: приватні контакти `ExternalBorrower`.
 *
 * Alias видно лише власнику контакту. `ownerInformed` — заява власника про
 * інформування, а не підтвердження з боку самої людини й не правова підстава (D2, відкритий blocker).
 * Клієнт не передає `ownerId`, `ownerInformedAt`, `retainUntil`, email чи нотатки:
 * запити суворі, зайві поля відхиляються.
 */

export const EXTERNAL_BORROWER_LIMITS = {
  aliasMax: 80,
} as const

export const externalBorrowerAliasSchema = z
  .string()
  .trim()
  .min(1, 'Вкажіть аліас')
  .max(EXTERNAL_BORROWER_LIMITS.aliasMax, 'Аліас задовгий')

export const createExternalBorrowerRequestSchema = z.strictObject({
  alias: externalBorrowerAliasSchema,
  ownerInformed: z.literal(true, { error: 'Потрібна заява власника' }),
})

export type CreateExternalBorrowerRequest = z.infer<typeof createExternalBorrowerRequestSchema>

export const updateExternalBorrowerRequestSchema = z.strictObject({
  alias: externalBorrowerAliasSchema,
})

export type UpdateExternalBorrowerRequest = z.infer<typeof updateExternalBorrowerRequestSchema>

export const externalBorrowerSchema = z.strictObject({
  id: z.string(),
  alias: z.string(),
  ownerInformedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * Stage 10 (10i.1, §0.13): нікнейм, email і час перевірки контролю email, які ПІДТВЕРДИВ гість
   * (усі три — `null` або всі не-`null`). Приватні: цей контракт owner-only (`/me/external-borrowers`,
   * `/guest-loan-confirmations`), у публічних відповідях їх немає. Не замінюють `alias` власника.
   */
  guestNickname: z.string().nullable(),
  guestEmail: z.string().nullable(),
  guestEmailVerifiedAt: z.iso.datetime().nullable(),
})

export type ExternalBorrower = z.infer<typeof externalBorrowerSchema>

export const externalBorrowerResponseSchema = z.strictObject({
  contact: externalBorrowerSchema,
})

export type ExternalBorrowerResponse = z.infer<typeof externalBorrowerResponseSchema>

export const externalBorrowerListResponseSchema = z.strictObject({
  contacts: z.array(externalBorrowerSchema),
})

export type ExternalBorrowerListResponse = z.infer<typeof externalBorrowerListResponseSchema>

/**
 * Stage 10, крок 10g: `POST /me/external-borrowers/:id/invitation`.
 *
 * D2 лишається відкритим release blocker — цей маршрут існує лише для розробки й перевірки з
 * вигаданими даними (T9: `GuestLoansEnabledGuard` + `GUEST_LOANS_SYNTHETIC_ONLY`). Як другий,
 * незалежний рубіж (а не заміна організаційної заборони, яку тримає PO) адреса обмежена
 * зарезервованим RFC 2606 доменом `.invalid`: він гарантовано не резолвиться, тож навіть помилкова
 * конфігурація транспорту не може випадково дістати реальну людину. Реальні персональні дані гостя
 * заборонені в усіх середовищах.
 */
export const GUEST_INVITATION_EMAIL_DOMAIN = 'guest.invalid'

export const guestInvitationEmailSchema = emailSchema.refine(
  (email) => email.endsWith(`@${GUEST_INVITATION_EMAIL_DOMAIN}`),
  `Лише синтетичні адреси домену ${GUEST_INVITATION_EMAIL_DOMAIN} (D2 — реальні дані заборонені)`,
)

export const createExternalBorrowerInvitationRequestSchema = z.strictObject({
  email: guestInvitationEmailSchema,
})

export type CreateExternalBorrowerInvitationRequest = z.infer<
  typeof createExternalBorrowerInvitationRequestSchema
>

/** Без відлуння email (Q4): лист і його адресат ніде в цій відповіді не з'являються. */
export const externalBorrowerInvitationResponseSchema = z.strictObject({
  invitation: invitationSchema,
})

export type ExternalBorrowerInvitationResponse = z.infer<
  typeof externalBorrowerInvitationResponseSchema
>
