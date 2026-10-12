import { z } from 'zod'
import { friendRelationSchema } from '../domain/friendship'
import { visibilitySchema } from '../domain/visibility'

/**
 * Обмеження полів профілю. Винесені константами, бо ті самі числа потрібні
 * `class-validator`-декораторам у `apps/api` (§11 вимагає обидва механізми).
 */
export const PROFILE_LIMITS = {
  displayNameMin: 2,
  displayNameMax: 80,
  bioMax: 500,
  avatarUrlMax: 2048,
  emailMax: 254,
} as const

// Нормалізація йде ДО перевірки формату: інакше « Marta@Example.com » з
// автопідстановки браузера відхиляється як «некоректна адреса» замість того,
// щоб просто обрізатися. Регістр локальної частини теоретично значущий,
// практично — ні в жодного провайдера; без зведення до нижнього «Marta@…» і
// «marta@…» стали б двома акаунтами.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Некоректна email-адреса').max(PROFILE_LIMITS.emailMax))

export const displayNameSchema = z
  .string()
  .trim()
  .min(PROFILE_LIMITS.displayNameMin, 'Імʼя закоротке')
  .max(PROFILE_LIMITS.displayNameMax, 'Імʼя задовге')

export const avatarUrlSchema = z.url('Некоректне посилання').max(PROFILE_LIMITS.avatarUrlMax)

export const bioSchema = z.string().trim().max(PROFILE_LIMITS.bioMax, 'Біо задовге')

/**
 * Профіль, який користувач бачить про себе (§9: власник — повний доступ).
 * `passwordHash` сюди не потрапляє ніколи — саме тому проєкція описана явно,
 * а не виводиться з моделі Prisma.
 */
export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  libraryVisibility: visibilitySchema,
  showHolderNames: z.boolean(),
  createdAt: z.iso.datetime(),
})

export type Me = z.infer<typeof meSchema>

/**
 * §9: «Профіль | Інший | імʼя + аватар». Ні email, ні налаштувань видимості —
 * саме тому це окрема схема, а не `meSchema.partial()`.
 */
export const publicUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
})

export type PublicUser = z.infer<typeof publicUserSchema>

/** §6.1: редагувати можна лише ці п'ять полів. Email міняється окремим флоу. */
export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema,
    avatarUrl: avatarUrlSchema.nullable(),
    bio: bioSchema.nullable(),
    libraryVisibility: visibilitySchema,
    showHolderNames: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Не передано жодного поля для зміни')

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>

export const USER_SEARCH_LIMIT = 20

/**
 * One search field (`?query=`): the name matches partially; when the whole value is a valid
 * email address, the address is also matched — exactly, never partially. The upper bound is the
 * longest valid address, which is longer than any display name.
 */
export const userSearchQuerySchema = z
  .string()
  .trim()
  .min(2, 'Мінімум два символи')
  .max(PROFILE_LIMITS.emailMax, 'Задовгий запит')

/**
 * §6.1: пошук за імʼям — частковий збіг; за email — ТІЛЬКИ точний.
 *
 * `query` — the unified field the interface uses. `q` (name only) and `email` (exact address
 * only) stay for compatibility. Exactly one of the three per request: a combination is a
 * malformed call, not a wider search. Partial matching of an address is impossible in every
 * form — otherwise someone else's email could be guessed letter by letter.
 */
export const userSearchRequestSchema = z
  .object({
    query: userSearchQuerySchema.optional(),
    q: z
      .string()
      .trim()
      .min(2, 'Мінімум два символи')
      .max(PROFILE_LIMITS.displayNameMax)
      .optional(),
    email: emailSchema.optional(),
  })
  .refine(
    (value) => [value.query, value.q, value.email].filter((v) => v !== undefined).length === 1,
    'Потрібен рівно один параметр: query, q або email',
  )

export type UserSearchRequest = z.infer<typeof userSearchRequestSchema>

/**
 * Знайдена людина разом зі станом звʼязку з нею.
 *
 * `relation` рахує API, а не фронт. Спокуса «перетнути список друзів зі списком
 * результатів на клієнті» виглядає дешевшою, але це рівно та сама авторизаційна
 * логіка, тільки продубльована за мережею й без доступу до `BLOCKED` — про блок
 * фронт не дізнається нізвідки, бо заблокованих пар немає в жодному зі списків.
 *
 * §9 це не порушує: `relation` описує стосунок того, хто дивиться, а не приватні
 * дані знайденого. Сама проєкція людини лишається `publicUserSchema`.
 */
export const userSearchResultSchema = z.object({
  user: publicUserSchema,
  relation: friendRelationSchema,
})

export type UserSearchResult = z.infer<typeof userSearchResultSchema>

export const userSearchResponseSchema = z.object({
  results: z.array(userSearchResultSchema).max(USER_SEARCH_LIMIT),
})

export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>
