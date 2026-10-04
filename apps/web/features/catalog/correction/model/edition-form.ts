import { editionFormatSchema, editionPatchRequestSchema } from '@bookswap/shared'
import { z } from 'zod'

/**
 * Same reasoning as `work-form.ts`/`translation-form.ts`.
 *
 * `format` у формі може бути порожнім: формат видання буває невідомим (`null`), і форма не має ні
 * вигадувати «м'яку палітурку», ні відправляти її лише тому, що користувач виправляв видавництво.
 * Порожнє значення означає «не змінювати» — у тіло PATCH воно не потрапляє.
 */
export const editionCorrectionFormSchema = editionPatchRequestSchema
  .required()
  .extend({ format: z.union([editionFormatSchema, z.literal('')]) })

export type EditionCorrectionFormValues = z.infer<typeof editionCorrectionFormSchema>
