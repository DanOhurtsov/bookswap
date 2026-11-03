'use client'

import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { AVATAR_RULES, type Me } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { removeAvatar, uploadAvatar } from '../api/profile-requests'
import { SAVE_TIMEOUT_MS } from './profile-form'

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

/**
 * A photo request that ran out of time (`SAVE_TIMEOUT_MS`). The server may still have done it, so the
 * words say only that the answer is unknown, and the retry is the person's own «Зберегти».
 */
export function avatarFailureMessage(error: unknown, action: 'upload' | 'remove'): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    const outcome = action === 'upload' ? 'збереглося' : 'видалилося'

    return `Сервер не відповів вчасно — невідомо, чи ${outcome} фото. Натисніть «Зберегти», щоб спробувати ще раз.`
  }

  return describeError(error)
}

/** The photo the form will save: the stored one as it is, a chosen file, or none at all. */
export type AvatarDraft =
  { kind: 'unchanged' } | { kind: 'replace'; file: File; previewUrl: string } | { kind: 'remove' }

const UNCHANGED: AvatarDraft = { kind: 'unchanged' }

/** What the picker shows: the chosen file's local preview, initials once removed, else the stored photo. */
export function shownAvatarUrl(draft: AvatarDraft, savedUrl: string | null): string | null {
  if (draft.kind === 'replace') return draft.previewUrl
  if (draft.kind === 'remove') return null

  return savedUrl
}

export interface AvatarUpload {
  /** The address the picker shows (`shownAvatarUrl`). */
  shownUrl: string | null
  /** The draft differs from the stored photo: «Зберегти» has a photo to send. */
  changed: boolean
  busy: 'upload' | 'remove' | null
  error: string | null
  choose: (file: File) => void
  remove: () => void
  /** Sends the draft, if any; `onDone` runs once the server has it (at once when nothing changed). */
  save: (onDone: () => void) => void
}

/**
 * The photo in the edit form. Choosing or removing it only changes the draft: nothing reaches the
 * server until the form's «Зберегти» calls `save`, so «Скасувати» or leaving the page keeps the stored
 * photo. The chosen file is previewed from a local object URL, released once the draft moves on.
 */
export function useAvatarUpload(
  savedUrl: string | null,
  onSaved: (changes: Partial<Me>) => void,
): AvatarUpload {
  const [draft, setDraft] = useState<AvatarDraft>(UNCHANGED)
  const [problem, setProblem] = useState<string | null>(null)
  // Only the photo is this request's news; the rest of the answer may be older than the form's.
  const savePhoto = (saved: Me) => {
    onSaved({ avatarUrl: saved.avatarUrl })
  }
  // Bounded like `PATCH /me`: a request with no answer would keep the whole form locked.
  const upload = useMutation({
    mutationFn: (photo: File) => uploadAvatar(photo, AbortSignal.timeout(SAVE_TIMEOUT_MS)),
    onSuccess: savePhoto,
  })
  const removal = useMutation({
    mutationFn: () => removeAvatar(AbortSignal.timeout(SAVE_TIMEOUT_MS)),
    onSuccess: savePhoto,
  })
  const failure =
    upload.error !== null
      ? avatarFailureMessage(upload.error, 'upload')
      : removal.error !== null
        ? avatarFailureMessage(removal.error, 'remove')
        : null
  const previewUrl = draft.kind === 'replace' ? draft.previewUrl : null

  // Created when a file is chosen; released when another draft replaces it or the form goes away.
  useEffect(() => {
    if (previewUrl === null) return

    return () => {
      URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  function startOver(next: AvatarDraft): void {
    setProblem(null)
    upload.reset()
    removal.reset()
    setDraft(next)
  }

  // `mutate`'s own callbacks: a form that is gone has no draft to clear and no save to finish.
  const sent = (onDone: () => void) => ({
    onSuccess: () => {
      setDraft(UNCHANGED)
      onDone()
    },
  })

  return {
    shownUrl: shownAvatarUrl(draft, savedUrl),
    changed: draft.kind !== 'unchanged',
    busy: upload.isPending ? 'upload' : removal.isPending ? 'remove' : null,
    error: problem ?? failure,
    choose: (file) => {
      const fileProblem = avatarFileProblem(file)

      // A file that would be refused leaves the previous choice as it was.
      if (fileProblem !== null) {
        setProblem(fileProblem)
        return
      }

      startOver({ kind: 'replace', file, previewUrl: URL.createObjectURL(file) })
    },
    // No photo at all: with none stored, that is no change — a chosen file is simply dropped.
    remove: () => {
      startOver(savedUrl === null ? UNCHANGED : { kind: 'remove' })
    },
    save: (onDone) => {
      if (draft.kind === 'replace') upload.mutate(draft.file, sent(onDone))
      else if (draft.kind === 'remove') removal.mutate(undefined, sent(onDone))
      else onDone()
    },
  }
}
