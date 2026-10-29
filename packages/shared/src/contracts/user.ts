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
  emailMax: 254,
  cityMax: 60,
} as const

/**
 * BS-148: the loan terms an owner may pick as the default (days). The web app fills an approval's due
 * date with it; the server never applies it on its own. The same values are a CHECK on
 * `User.defaultLoanTermDays`.
 */
export const LOAN_TERM_OPTIONS = [14, 21, 30] as const

export type LoanTermDays = (typeof LOAN_TERM_OPTIONS)[number]

const loanTermDaysSchema = z.literal(LOAN_TERM_OPTIONS, 'Термін — 14, 21 або 30 днів')

/**
 * BS-148: a profile photo is uploaded as a file (`POST /me/avatar`, the raw bytes as the body) and
 * stored as a centred square. The type is told by the bytes, never by `Content-Type`; the server
 * re-encodes every photo, so what is stored is always `side`×`side` WebP without metadata.
 */
export const AVATAR_RULES = {
  maxBytes: 5 * 1024 * 1024,
  /** The shorter side of the original: a smaller photo would be visibly upscaled at 96 px ×2. */
  minSide: 256,
  side: 512,
  types: ['image/jpeg', 'image/png', 'image/webp'],
} as const

/**
 * BS-148: the nickname is the person's public address (`/u/<handle>`), so it is held to URL-safe
 * rules: lowercase Latin letters and digits, with single `-` or `_` between them — never at an edge
 * and never two in a row. The same format is a CHECK on `User.handle` in the database.
 *
 * Reserved names are words a person could be mistaken for the service by, or that read as a route.
 * A reserved name answers exactly like a taken one: the user needs no separate explanation.
 * `library`: `GET /users/handles/library` would also match `GET /users/:id/library`, and which one
 * answers would depend on the order Nest registers the modules in.
 */
export const HANDLE_RULES = {
  min: 3,
  max: 30,
  pattern: /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
  reserved: [
    'admin',
    'administrator',
    'api',
    'bookswap',
    'edit',
    'help',
    'library',
    'moderator',
    'profile',
    'root',
    'settings',
    'support',
    'system',
    'user',
    'users',
  ],
} as const

const HANDLE_FORMAT_MESSAGE = 'Лише латинські літери, цифри, - та _, від 3 до 30 символів'

/** Trimmed and lowercased first: «Danylo» and «danylo» are one nickname, not two. */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(HANDLE_RULES.min, HANDLE_FORMAT_MESSAGE)
      .max(HANDLE_RULES.max, HANDLE_FORMAT_MESSAGE)
      .regex(HANDLE_RULES.pattern, HANDLE_FORMAT_MESSAGE),
  )

/** Expects a normalized handle (`handleSchema`'s output). */
export function isReservedHandle(handle: string): boolean {
  return (HANDLE_RULES.reserved as readonly string[]).includes(handle)
}

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

export const bioSchema = z.string().trim().max(PROFILE_LIMITS.bioMax, 'Біо задовге')

/** BS-148: a city of only spaces is no city — stored as `null`, never as an empty string. */
export const citySchema = z
  .string()
  .trim()
  .max(PROFILE_LIMITS.cityMax, 'Назва міста задовга')
  .transform((city) => (city === '' ? null : city))

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
  handle: z.string(),
  city: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  libraryVisibility: visibilitySchema,
  showHolderNames: z.boolean(),
  // BS-148: lending settings.
  friendsOfFriendsAccess: z.boolean(),
  loanRequestsPaused: z.boolean(),
  defaultLoanTermDays: loanTermDaysSchema.nullable(),
  ownerDueReminders: z.boolean(),
  createdAt: z.iso.datetime(),
})

export type Me = z.infer<typeof meSchema>

/**
 * §9: «Профіль | Інший | імʼя + аватар»; BS-148 adds the nickname — it is the person's public address.
 * Ні email, ні налаштувань видимості — саме тому це окрема схема, а не `meSchema.partial()`.
 */
export const publicUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  handle: z.string(),
  avatarUrl: z.string().nullable(),
})

export type PublicUser = z.infer<typeof publicUserSchema>

/**
 * §6.1, BS-148: the fields a profile edit may change. Email changes through its own flow; the photo
 * through `POST /me/avatar` / `DELETE /me/avatar` — an address of someone else's choosing is never
 * stored as an avatar.
 */
export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema,
    handle: handleSchema,
    city: citySchema.nullable(),
    bio: bioSchema.nullable(),
    libraryVisibility: visibilitySchema,
    showHolderNames: z.boolean(),
    friendsOfFriendsAccess: z.boolean(),
    loanRequestsPaused: z.boolean(),
    defaultLoanTermDays: loanTermDaysSchema.nullable(),
    ownerDueReminders: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Не передано жодного поля для зміни')

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>

/**
 * `GET /users/handles/:handle/availability`. The caller's own current nickname is available: keeping
 * it is not a conflict. A reserved name is not available, with no separate reason (`HANDLE_RULES`).
 */
export const handleAvailabilitySchema = z.object({ available: z.boolean() })

export type HandleAvailability = z.infer<typeof handleAvailabilitySchema>

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
