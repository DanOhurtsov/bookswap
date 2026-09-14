import { translationPatchRequestSchema } from '@bookswap/shared'
import type { z } from 'zod'

/**
 * Same reasoning as `work-form.ts`: `translationPatchRequestSchema` makes
 * every field optional for the wire (a PATCH may touch just one); the form
 * always has a concrete value in each, so `.required()` is used only to type
 * and validate the form. `submit()` builds the actual PATCH body by hand.
 */
export const translationCorrectionFormSchema = translationPatchRequestSchema.required()

export type TranslationCorrectionFormValues = z.infer<typeof translationCorrectionFormSchema>
