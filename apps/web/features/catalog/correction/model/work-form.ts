import { languageCodeSchema, workPatchRequestSchema } from '@bookswap/shared'
import { z } from 'zod'

/**
 * `workPatchRequestSchema` makes every field optional (a PATCH may touch just
 * one) — right for the wire, wrong for a form, which always has a concrete
 * value in every field (react-hook-form's `defaultValues` guarantee that).
 * `.required()` only changes which KEYS the resolver demands present; the
 * per-field rules (min/max length, nullable-ness, the author element shape)
 * are untouched. The actual PATCH body is built by hand in `submit()` — this
 * schema exists only to validate and type the form, never sent as-is.
 */
export const workCorrectionFormSchema = workPatchRequestSchema
  .required()
  // Мова оригіналу буває невідомою (`null`): порожнє поле означає «не змінювати» й у тіло PATCH не
  // потрапляє — інакше збереження назви твору без відомої мови вимагало б її вигадати.
  .extend({ origLang: z.union([languageCodeSchema, z.literal('')]) })

export type WorkCorrectionFormValues = z.infer<typeof workCorrectionFormSchema>
