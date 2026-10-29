import {
  API_ERROR_CODES,
  PROFILE_LIMITS,
  bioSchema,
  citySchema,
  displayNameSchema,
  handleSchema,
  type Me,
  type UpdateProfileRequest,
} from '@bookswap/shared'
import { z } from 'zod'
import { ApiRequestError } from '@/app/lib/api'

/** The canvas wording for a missing name; a too long one keeps the shared message. */
export const NAME_REQUIRED_MESSAGE = 'Вкажіть ім’я — так друзі вас упізнають'

/** «Про себе» turns amber from here on (PO decision 6, 26.10.2026). */
export const BIO_WARN_FROM = 450

/**
 * The edit form's schema (CONVENTIONS §4.3): the form's values in, the saved shape out.
 *
 * The field rules are the shared ones, the same the API runs. Only two things are decided here: a
 * name that is empty or too short is asked for in the canvas's words, and text inputs never hold
 * `null` — an empty «Про себе» means "remove", which the API reads as `null`.
 *
 * BS-148: no photo field — the photo is uploaded on its own (`POST /me/avatar`), never typed in as an
 * address. Visibility and holder names moved to the «Акаунт» card, which saves them at once.
 */
export const profileFormSchema = z.object({
  displayName: z
    .string()
    .refine((name) => name.trim().length >= PROFILE_LIMITS.displayNameMin, NAME_REQUIRED_MESSAGE)
    .pipe(displayNameSchema),
  handle: handleSchema,
  city: citySchema,
  bio: bioSchema.transform((bio) => (bio === '' ? null : bio)),
})

export type ProfileFormValues = z.input<typeof profileFormSchema>

export type ProfileFormOutput = z.output<typeof profileFormSchema>

/** The values every edit session starts from: the last profile the server confirmed. */
export function toProfileFormValues(user: Me): ProfileFormValues {
  return {
    displayName: user.displayName,
    handle: user.handle,
    city: user.city ?? '',
    bio: user.bio ?? '',
  }
}

/**
 * Only what differs from the saved profile goes to `PATCH /me`. Compared after normalizing: a space
 * added at the end of the name is no change. `null` when nothing would change at all.
 */
export function profileChanges(form: ProfileFormOutput, saved: Me): UpdateProfileRequest | null {
  const changes: UpdateProfileRequest = {}

  if (form.displayName !== saved.displayName) changes.displayName = form.displayName
  if (form.handle !== saved.handle) changes.handle = form.handle
  if (form.city !== saved.city) changes.city = form.city
  if (form.bio !== saved.bio) changes.bio = form.bio

  return Object.keys(changes).length === 0 ? null : changes
}

/**
 * What a nickname field holds while it is typed in: the canvas lowercases and drops spaces as you go,
 * so the field never shows a value the server would store differently.
 */
export function normalizeHandleInput(value: string): string {
  return value.toLowerCase().replace(/\s/g, '')
}

/** Canvas spec: a save that has not answered in 10 s is shown as failed, the draft kept. */
export const SAVE_TIMEOUT_MS = 10_000

/**
 * How a failed save is shown. A taken nickname goes under the nickname; any other answer the server
 * gave about the request is said above the fields as it is; no answer at all — the network, a
 * timeout, a 5xx — is the banner with «Спробувати ще», since only that kind may pass on its own.
 */
export type SaveFailure =
  | { kind: 'handle'; message: string }
  | { kind: 'request'; error: ApiRequestError }
  | { kind: 'connection' }

export function saveFailureOf(error: unknown): SaveFailure {
  if (error instanceof ApiRequestError) {
    if (error.code === API_ERROR_CODES.HANDLE_TAKEN) {
      return { kind: 'handle', message: error.message }
    }

    if (error.status < 500) return { kind: 'request', error }
  }

  return { kind: 'connection' }
}
