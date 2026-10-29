'use client'

import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { AVATAR_RULES, type Me } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { removeAvatar, uploadAvatar } from '../api/profile-requests'

const MAX_MB = AVATAR_RULES.maxBytes / 1024 / 1024

/**
 * What can be told before sending: the canvas's two messages, the same the server answers with. A
 * file of unknown type goes on — its bytes, not its name, decide on the server; so does a photo that
 * may be too small, which only decoding it can tell.
 */
export function avatarFileProblem(file: Pick<File, 'size' | 'type'>): string | null {
  if (file.type !== '' && !(AVATAR_RULES.types as readonly string[]).includes(file.type)) {
    return 'Підтримуються JPG, PNG і WebP'
  }

  if (file.size > AVATAR_RULES.maxBytes) return `Файл завеликий — до ${String(MAX_MB)} МБ`

  return null
}

export interface AvatarUpload {
  busy: 'upload' | 'remove' | null
  error: string | null
  choose: (file: File) => void
  remove: () => void
}

/**
 * BS-148: the photo is saved as soon as it is chosen, apart from the form (canvas spec): the session
 * takes the new profile at once, and «Скасувати» on the form does not take the photo back.
 */
export function useAvatarUpload(onSaved: (changes: Partial<Me>) => void): AvatarUpload {
  const [problem, setProblem] = useState<string | null>(null)
  // Only the photo is this request's news; the rest of the answer may be older than the form's.
  const savePhoto = (saved: Me) => {
    onSaved({ avatarUrl: saved.avatarUrl })
  }
  const upload = useMutation({ mutationFn: uploadAvatar, onSuccess: savePhoto })
  const removal = useMutation({ mutationFn: removeAvatar, onSuccess: savePhoto })
  const failed = upload.error ?? removal.error

  function startOver(): void {
    setProblem(null)
    upload.reset()
    removal.reset()
  }

  return {
    busy: upload.isPending ? 'upload' : removal.isPending ? 'remove' : null,
    error: problem ?? (failed === null ? null : describeError(failed)),
    choose: (file) => {
      startOver()

      const fileProblem = avatarFileProblem(file)

      if (fileProblem !== null) {
        setProblem(fileProblem)
        return
      }

      upload.mutate(file)
    },
    remove: () => {
      startOver()
      removal.mutate()
    },
  }
}
