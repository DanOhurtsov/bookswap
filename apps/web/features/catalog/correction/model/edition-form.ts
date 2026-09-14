import { editionPatchRequestSchema } from '@bookswap/shared'
import type { z } from 'zod'

/** Same reasoning as `work-form.ts`/`translation-form.ts`. */
export const editionCorrectionFormSchema = editionPatchRequestSchema.required()

export type EditionCorrectionFormValues = z.infer<typeof editionCorrectionFormSchema>
