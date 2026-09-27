import { z } from 'zod'

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
