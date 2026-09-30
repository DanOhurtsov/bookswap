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

/** `GET /me/reading-statuses/:workId`: `wasBorrowed` обчислюється, а не зберігається (T12). */
export const readingStatusResponseSchema = z.strictObject({
  workId: idSchema,
  status: readingStatusSchema,
  wasBorrowed: z.boolean(),
})

export type ReadingStatusResponse = z.infer<typeof readingStatusResponseSchema>

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
