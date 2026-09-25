import { z } from 'zod'
import { copyStatusSchema } from '../domain/copy'
import { publicUserSchema } from './user'

/**
 * Етап 9: примірники «мого кола». Одна проєкція для `/catalog/discover` і
 * `/works/:id/holders`, щоб два екрани не розійшлися в тому, що вважають
 * доступним і кому дозволено просити.
 *
 * Приватного тут немає: ні `note`, ні `visibility`, ні `condition`, ні
 * позичальника — лише те, що гість бібліотеки бачить і так.
 */
export const networkCopySchema = z.object({
  id: z.string(),
  editionId: z.string(),
  /** `null` — видання мовою оригіналу. */
  translationId: z.string().nullable(),
  status: copyStatusSchema,
  /** Лише дата, лише для `RESERVED`/`LENT_OUT` — правило §6.5. */
  expectedReturnAt: z.iso.date().nullable(),
  /** Серверне рішення: кнопку «Попросити» не малюють за статусом. */
  canRequest: z.boolean(),
})

export type NetworkCopy = z.infer<typeof networkCopySchema>

export const networkOwnerSchema = z.object({
  owner: publicUserSchema,
  relation: z.enum(['SELF', 'FRIEND', 'OTHER']),
  /** Скільки з видимих примірників зараз можна позичити. */
  availableCopies: z.number().int().nonnegative(),
  copies: z.array(networkCopySchema).min(1),
})

export type NetworkOwner = z.infer<typeof networkOwnerSchema>

export const WORK_HOLDERS_AVAILABILITY = ['AVAILABLE', 'ANY'] as const
export const workHoldersAvailabilitySchema = z.enum(WORK_HOLDERS_AVAILABILITY)

export const workHoldersRequestSchema = z.object({
  /** Лише цей переклад; `original` — видання мовою оригіналу. */
  translationId: z.string().trim().min(1).max(64).optional(),
  availability: workHoldersAvailabilitySchema.default('ANY'),
})

export const workHolderGroupSchema = z.object({
  translationId: z.string().nullable(),
  language: z.string(),
  translator: z.string().nullable(),
  owners: z.array(networkOwnerSchema).min(1),
})

export type WorkHolderGroup = z.infer<typeof workHolderGroupSchema>

export const workHoldersResponseSchema = z.object({
  workId: z.string(),
  groups: z.array(workHolderGroupSchema),
})

export type WorkHoldersResponse = z.infer<typeof workHoldersResponseSchema>
