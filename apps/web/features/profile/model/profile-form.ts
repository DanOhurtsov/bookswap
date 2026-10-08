import {
  updateProfileRequestSchema,
  visibilitySchema,
  type Me,
  type Visibility,
} from '@bookswap/shared'
import { z } from 'zod'

/** One wording for a visibility value, read by both the profile view and the edit form. */
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  PUBLIC: 'Публічна — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватна — тільки я',
}

/**
 * The edit form's schema (CONVENTIONS §4.3): the form's values in, the `PATCH /me` body out.
 *
 * It adds no rules of its own — the field rules are the shared `updateProfileRequestSchema`, the
 * same one the API runs, reached through `pipe`. The only thing decided here is the mapping: text
 * inputs never hold `null`, so an empty field means "remove", not "store emptiness" — the API tells
 * `null` apart from an absent field, and the form must speak the same language.
 */
export const profileFormSchema = z
  .object({
    displayName: z.string(),
    avatarUrl: z.string(),
    bio: z.string(),
    libraryVisibility: visibilitySchema,
    showHolderNames: z.boolean(),
  })
  .transform((values): z.input<typeof updateProfileRequestSchema> => ({
    ...values,
    avatarUrl: values.avatarUrl.trim() === '' ? null : values.avatarUrl.trim(),
    bio: values.bio.trim() === '' ? null : values.bio,
  }))
  .pipe(updateProfileRequestSchema)

export type ProfileFormValues = z.input<typeof profileFormSchema>

/** The values every edit session starts from: the last profile the server confirmed. */
export function toProfileFormValues(user: Me): ProfileFormValues {
  return {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? '',
    bio: user.bio ?? '',
    libraryVisibility: user.libraryVisibility,
    showHolderNames: user.showHolderNames,
  }
}
