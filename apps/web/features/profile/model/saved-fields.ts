import type { Me, UpdateProfileRequest } from '@bookswap/shared'

/**
 * What one profile request saved, and only that. Every answer carries the whole profile, but only the
 * fields the request changed are news: the rest is as old as that answer, and an answer to another
 * request — the photo, a setting, the form — may already have brought a newer value for them. Taken
 * field by field, the answers can land in any order, and a failed one changes nothing.
 */
export function savedFields(saved: Me, changes: UpdateProfileRequest): Partial<Me> {
  const fields = Object.keys(changes).filter((key): key is keyof Me => key in saved)

  return fields.reduce<Partial<Me>>((picked, field) => ({ ...picked, [field]: saved[field] }), {})
}
