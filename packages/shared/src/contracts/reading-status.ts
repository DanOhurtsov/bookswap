import { z } from 'zod'
import { readingListStatusSchema, readingStatusSchema } from '../domain/reading-status'
import { workAuthorSchema, workSchema } from './catalog'

/**
 * Stage 10 (10j.1, §6.15 T13): особисті статуси читання. Усі маршрути — `/me/*`, користувач лише з
 * сесії; жодне з цих полів не з'являється у спільних відповідях історії, каталогу, позик чи друзів (R-8).
 */

export const READING_LIST_LIMITS = {
  idMax: 64,
  cursorMax: 256,
  pageDefault: 20,
  pageMax: 50,
} as const

const idSchema = z.string().trim().min(1).max(READING_LIST_LIMITS.idMax)

/** `PUT /me/reading-statuses/:workId`. */
export const setReadingStatusRequestSchema = z.strictObject({
  status: readingStatusSchema,
})

export type SetReadingStatusRequest = z.infer<typeof setReadingStatusRequestSchema>

export const setReadingStatusResponseSchema = z.strictObject({
  workId: idSchema,
  status: readingStatusSchema,
})

export type SetReadingStatusResponse = z.infer<typeof setReadingStatusResponseSchema>

/**
 * `GET /me/reading-statuses/:workId`: `wasBorrowed` обчислюється, а не зберігається (T12).
 *
 * BS-140: `isSet` — чи є запис взагалі. `status` без запису лишається `NOT_READ` заради наявних
 * споживачів, тож відрізнити «не встановлено» від явного `NOT_READ` можна лише за `isSet`.
 */
export const readingStatusResponseSchema = z.strictObject({
  workId: idSchema,
  status: readingStatusSchema,
  isSet: z.boolean(),
  wasBorrowed: z.boolean(),
})

export type ReadingStatusResponse = z.infer<typeof readingStatusResponseSchema>

const BATCH_IDS_MAX = 100

/** BS-140: межі пакетного `GET /me/reading-statuses?workIds=a,b,…`. */
export const READING_STATUS_BATCH_LIMITS = {
  /** Унікальних ID в одному пакеті. Більше — кілька пакетів. */
  idsMax: BATCH_IDS_MAX,
  /** Сирий рядок: кожен ID разом із комою. Обмежує роботу ще до розбору. */
  queryMax: BATCH_IDS_MAX * (READING_LIST_LIMITS.idMax + 1),
  /** Відмова для хибного `workIds` — та сама в zod-схемі й у DTO. */
  invalidMessage: `workIds: від 1 до ${String(BATCH_IDS_MAX)} ID через кому`,
} as const

const WORK_ID_IN_LIST = new RegExp(`^[^\\s,]{1,${String(READING_LIST_LIMITS.idMax)}}$`)

/**
 * Розбір `workIds`: ID через кому, без пробілів і порожніх елементів. Повтори зливаються в порядку
 * першої появи; ліміт рахує вже унікальні ID. `undefined` — список хибний або задовгий.
 */
export function parseWorkIdList(raw: string): string[] | undefined {
  if (raw.length > READING_STATUS_BATCH_LIMITS.queryMax) return undefined

  const parts = raw.split(',')

  if (!parts.every((part) => WORK_ID_IN_LIST.test(part))) return undefined

  const unique = [...new Set(parts)]

  return unique.length <= READING_STATUS_BATCH_LIMITS.idsMax ? unique : undefined
}

/** `GET /me/reading-statuses?workIds=…`. DTO приймає рівно ті самі значення. */
export const readingStatusesQueryRequestSchema = z.strictObject({
  workIds: z.string().transform((raw, context) => {
    const ids = parseWorkIdList(raw)

    if (ids === undefined) {
      context.addIssue({ code: 'custom', message: READING_STATUS_BATCH_LIMITS.invalidMessage })

      return z.NEVER
    }

    return ids
  }),
})

/**
 * Елемент пакета: стан канонічного твору (`workId`) для ID, який запитали (`requestedWorkId`). Невідомий
 * ID у відповідь не потрапляє.
 */
const readingStatusesItemSchema = z.strictObject({
  ...readingStatusResponseSchema.shape,
  requestedWorkId: idSchema,
})

export const readingStatusesResponseSchema = z.strictObject({
  items: z.array(readingStatusesItemSchema),
})

export type ReadingStatusesResponse = z.infer<typeof readingStatusesResponseSchema>

/**
 * `GET /me/reading-list`. `NOT_READ` не є значенням фільтра. Query-параметри приходять рядками, тому
 * `limit` — рядок цілого; DTO приймає рівно ті самі значення.
 */
export const readingListQueryRequestSchema = z.strictObject({
  status: readingListStatusSchema.optional(),
  cursor: z.string().min(1).max(READING_LIST_LIMITS.cursorMax).optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .refine((value) => Number(value) <= READING_LIST_LIMITS.pageMax)
    .optional(),
})

export type ReadingListQueryRequest = z.infer<typeof readingListQueryRequestSchema>

export const readingListItemSchema = z.strictObject({
  work: workSchema,
  authors: z.array(workAuthorSchema),
  status: readingListStatusSchema,
  wasBorrowed: z.boolean(),
  updatedAt: z.iso.datetime(),
})

export type ReadingListItem = z.infer<typeof readingListItemSchema>

export const readingListResponseSchema = z.strictObject({
  items: z.array(readingListItemSchema),
  nextCursor: z.string().nullable(),
})

export type ReadingListResponse = z.infer<typeof readingListResponseSchema>
