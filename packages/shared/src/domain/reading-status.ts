import { z } from 'zod'

/**
 * Stage 10 (10j, R-1): особистий статус читання.
 *
 * Дублює Prisma-enum `ReadingStatus`; розсинхрон ловить
 * `apps/api/src/common/enum-parity.spec.ts`.
 */
export const READING_STATUS = ['NOT_READ', 'READING', 'READ'] as const

export const readingStatusSchema = z.enum(READING_STATUS)

export type ReadingStatus = z.infer<typeof readingStatusSchema>

/** Статуси, що потрапляють в особистий список: явний `NOT_READ` у ньому не показується. */
export const READING_LIST_STATUS = ['READING', 'READ'] as const

export const readingListStatusSchema = z.enum(READING_LIST_STATUS)

export type ReadingListStatus = z.infer<typeof readingListStatusSchema>
