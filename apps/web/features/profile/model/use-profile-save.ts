'use client'

import { useMutation } from '@tanstack/react-query'
import type { Me, UpdateProfileRequest } from '@bookswap/shared'
import { useToastManager } from '@/components/ui/toast'
import { updateProfile } from '../api/profile-requests'
import { SAVE_TIMEOUT_MS, saveFailureOf, type SaveFailure } from './profile-form'
import { savedFields } from './saved-fields'
import type { AvatarUpload } from './use-avatar-upload'

/** The canvas: «Профіль оновлено» for 3 s after a successful save. */
export const PROFILE_UPDATED_MS = 3000

export interface ProfileSave {
  saving: boolean
  /** Shown above the fields; a taken nickname is reported to its field instead (`onHandleTaken`). */
  failure: Exclude<SaveFailure, { kind: 'handle' }> | null
  /** The changed fields (`null` when only the photo changed), then the photo draft. */
  save: (changes: UpdateProfileRequest | null) => void
}

/**
 * BS-148: one save of the edit form, and everything a success means — the session takes the saved
 * fields (the header's name with them), «Профіль оновлено» shows, and the form is left. One place
 * does all three, so no caller can do one and forget another.
 *
 * The photo draft goes only after `PATCH /me` has succeeded (PO decision, 03.11.2026): a refused form
 * never replaces the stored photo. The toast and the way out wait for the photo too: when it fails, the
 * saved fields stay saved, the form stays open with the photo's error, and the next «Зберегти» sends
 * only what is left. The form starts over from the saved fields (`rebase`) as soon as they are saved,
 * so what counts as a change is always measured against what the server has confirmed.
 *
 * The two halves outlive the form differently. What the server saved is the account's whatever
 * happens to the form, so it goes to the session from the mutation itself (`onSaved` decides whether
 * that account is still signed in). The toast, the way out and the nickname error belong to this form
 * only: they are `mutate`'s own callbacks, which React Query drops once the form is gone — after a
 * logout, another login or a link followed while the save was in flight.
 */
export function useProfileSave({
  onSaved,
  onHandleTaken,
  leave,
  rebase,
  photo,
}: {
  onSaved: (changes: Partial<Me>) => void
  onHandleTaken: (message: string) => void
  leave: () => void
  /** The form's fields are now these saved values; the photo draft is not touched. */
  rebase: (saved: Partial<Me>) => void
  photo: AvatarUpload
}): ProfileSave {
  const toasts = useToastManager()
  const mutation = useMutation({
    mutationFn: (changes: UpdateProfileRequest) =>
      updateProfile(changes, AbortSignal.timeout(SAVE_TIMEOUT_MS)),
    onSuccess: (saved, changes) => {
      onSaved(savedFields(saved, changes))
    },
  })
  const failure = mutation.error === null ? null : saveFailureOf(mutation.error)

  const sendPhoto = () => {
    photo.save(() => {
      toasts.add({ title: 'Профіль оновлено', timeout: PROFILE_UPDATED_MS })
      leave()
    })
  }

  return {
    saving: mutation.isPending || photo.busy !== null,
    failure: failure === null || failure.kind === 'handle' ? null : failure,
    save: (changes) => {
      if (changes === null) {
        sendPhoto()
        return
      }

      mutation.mutate(changes, {
        onSuccess: (saved) => {
          rebase(savedFields(saved, changes))
          sendPhoto()
        },
        onError: (error) => {
          const failure = saveFailureOf(error)

          if (failure.kind === 'handle') onHandleTaken(failure.message)
        },
      })
    },
  }
}
