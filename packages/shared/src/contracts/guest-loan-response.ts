import { z } from 'zod'
import { guestResponseAnswerSchema } from '../domain/loan'
import { guestInvitationEmailSchema } from './external-borrower'

/**
 * Stage 10, крок 10i.2: ПУБЛІЧНІ маршрути гостя без акаунта (`/api/v1/guest-loan-responses/*`, за
 * `GuestLoansEnabledGuard`). Лише синтетичні дані (D2): адреса гостя обмежена доменом `guest.invalid`.
 *
 * Токен посилання — завжди в ТІЛІ (не в path/query: адреси потрапляють у логи проксі). Жодна відповідь
 * не містить email, alias власника, нікнейма, id контакту чи історії. Доказ — відповідь через посилання
 * після підтвердження контролю введеного email; посилання можна передати іншій людині, тож ці контракти
 * НЕ стверджують, що доведено особу первісного адресата (§0.12 п. 4).
 */

export const GUEST_RESPONSE_LIMITS = {
  nicknameMax: 60,
  tokenMax: 128,
  codeLength: 6,
} as const

const tokenSchema = z.string().trim().min(1).max(GUEST_RESPONSE_LIMITS.tokenMax)

export const guestResponseNicknameSchema = z
  .string()
  .trim()
  .min(1, 'Вкажіть нікнейм')
  .max(GUEST_RESPONSE_LIMITS.nicknameMax, 'Нікнейм задовгий')

const codeSchema = z.string().regex(/^\d{6}$/, 'Код — шість цифр')

/** `POST /guest-loan-responses/resolve` — що саме підтверджує гість (без email, alias, історії). */
export const resolveGuestResponseRequestSchema = z.strictObject({ token: tokenSchema })

export type ResolveGuestResponseRequest = z.infer<typeof resolveGuestResponseRequestSchema>

export const resolveGuestResponseResponseSchema = z.strictObject({
  book: z.strictObject({ title: z.string(), authors: z.array(z.string()) }),
  expiresAt: z.iso.datetime(),
})

export type ResolveGuestResponseResponse = z.infer<typeof resolveGuestResponseResponseSchema>

/** `POST /guest-loan-responses/code` — надіслати одноразовий шестизначний код на адресу гостя. */
export const requestGuestCodeRequestSchema = z.strictObject({
  token: tokenSchema,
  nickname: guestResponseNicknameSchema,
  email: guestInvitationEmailSchema,
})

export type RequestGuestCodeRequest = z.infer<typeof requestGuestCodeRequestSchema>

/** Без відлуння адреси чи коду. */
export const requestGuestCodeResponseSchema = z.strictObject({ codeExpiresAt: z.iso.datetime() })

export type RequestGuestCodeResponse = z.infer<typeof requestGuestCodeResponseSchema>

/** `POST /guest-loan-responses/verify` — довести контроль адреси; результат — короткоживучий доказ. */
export const verifyGuestCodeRequestSchema = requestGuestCodeRequestSchema.extend({
  code: codeSchema,
})

export type VerifyGuestCodeRequest = z.infer<typeof verifyGuestCodeRequestSchema>

export const verifyGuestCodeResponseSchema = z.strictObject({
  proof: z.string(),
  proofExpiresAt: z.iso.datetime(),
})

export type VerifyGuestCodeResponse = z.infer<typeof verifyGuestCodeResponseSchema>

/** `POST /guest-loan-responses/answer` — єдина відповідь: лише з доказом, прив'язаним до цієї адреси й нікнейма. */
export const answerGuestResponseRequestSchema = z.strictObject({
  token: tokenSchema,
  nickname: guestResponseNicknameSchema,
  email: guestInvitationEmailSchema,
  proof: tokenSchema,
  answer: guestResponseAnswerSchema,
})

export type AnswerGuestResponseRequest = z.infer<typeof answerGuestResponseRequestSchema>

export const answerGuestResponseResponseSchema = z.strictObject({
  answer: guestResponseAnswerSchema,
})

export type AnswerGuestResponseResponse = z.infer<typeof answerGuestResponseResponseSchema>
