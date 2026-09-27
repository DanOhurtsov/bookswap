import { z } from 'zod'
import { displayNameSchema, emailSchema, meSchema } from './user'

/**
 * §6.1: реєстрація за email + пароль, автентифікація через серверну session
 * cookie. JWT свідомо немає — фронт і бек за одним доменом через Caddy.
 */

export const PASSWORD_LIMITS = {
  /** Довжина, а не «одна велика, одна цифра, один символ»: правила складності
   * женуть людей до `Password1!`, довжина дає ентропію без цього. */
  min: 10,
  /** Верхня межа не про безпеку, а про DoS: scrypt на мегабайтному вводі — це подарунок. */
  max: 200,
} as const

export const passwordSchema = z
  .string()
  .min(PASSWORD_LIMITS.min, `Пароль коротший за ${String(PASSWORD_LIMITS.min)} символів`)
  .max(PASSWORD_LIMITS.max, 'Пароль задовгий')

/** Одноразові токени з листів. Ходять у тілі запиту, не в URL API. */
export const tokenSchema = z.string().min(1).max(200)

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
})

export type RegisterRequest = z.infer<typeof registerRequestSchema>

export const loginRequestSchema = z.object({
  email: emailSchema,
  // На вході в логін пароль не валідується за політикою: інакше «закороткий
  // пароль» відрізняв би стару вимогу від нової і підказував формат чужого.
  password: z.string().min(1).max(PASSWORD_LIMITS.max),
})

export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * Доступність функцій, яку сервер віддає разом із сесією. Прапор читає лише
 * сервер (конфігурація), клієнтського env для нього немає (Stage 10 §7.3, T9).
 */
export const sessionFeaturesSchema = z.object({
  /** Гостьові позики та їхні контакти. Увімкнено лише для синтетичних даних; D2 відкритий. */
  guestLoans: z.boolean(),
})

export type SessionFeatures = z.infer<typeof sessionFeaturesSchema>

/** Відповідь і на register, і на login, і на GET /auth/session — та сама форма. */
export const sessionResponseSchema = z.object({
  user: meSchema,
  features: sessionFeaturesSchema,
})

export type SessionResponse = z.infer<typeof sessionResponseSchema>

export const confirmEmailRequestSchema = z.object({
  token: tokenSchema,
})

export type ConfirmEmailRequest = z.infer<typeof confirmEmailRequestSchema>

export const requestPasswordResetRequestSchema = z.object({
  email: emailSchema,
})

export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>

export const confirmPasswordResetRequestSchema = z.object({
  token: tokenSchema,
  password: passwordSchema,
})

export type ConfirmPasswordResetRequest = z.infer<typeof confirmPasswordResetRequestSchema>

/**
 * Відповідь на запит скидання пароля і на повторне надсилання підтвердження.
 *
 * Форма стала й не залежить від того, чи існує акаунт: інакше сам факт відповіді
 * перетворює ендпоінт на перевірку «чи зареєстрований цей email».
 */
export const acceptedResponseSchema = z.object({
  accepted: z.literal(true),
})

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>
