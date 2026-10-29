'use client'

import { useRef } from 'react'
import { AVATAR_RULES, type Me } from '@bookswap/shared'
import { Button } from '@/components/ui/button'
import type { AvatarUpload } from '../model/use-avatar-upload'
import { ProfileAvatar } from './ProfileParts'

/**
 * The photo in the edit card. Saved the moment a file is chosen, apart from the form's «Зберегти»
 * (canvas spec); the server squares and re-encodes it, so what is shown is the stored photo.
 */
export function AvatarPicker({ user, avatar }: { user: Me; avatar: AvatarUpload }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = avatar.busy !== null

  return (
    <div className="flex shrink-0 flex-col items-start gap-2 md:w-36 md:items-center">
      <ProfileAvatar user={user} className="size-24" fallbackClassName="text-[34px] font-bold" />
      {/* Opened by «Змінити фото»: a file input cannot be styled as the canvas's button. */}
      <input
        ref={fileInput}
        type="file"
        accept={AVATAR_RULES.types.join(',')}
        aria-label="Фото профілю"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]

          // The same file picked again after an error must still fire `change`.
          event.target.value = ''
          if (file !== undefined) avatar.choose(file)
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="px-3 font-semibold"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {avatar.busy === 'upload' ? 'Завантажую фото…' : 'Змінити фото'}
      </Button>
      {user.avatarUrl !== null && (
        <button type="button" className="button--link m-0" disabled={busy} onClick={avatar.remove}>
          {avatar.busy === 'remove' ? 'Видаляю фото…' : 'Видалити фото'}
        </button>
      )}
      {avatar.error !== null && (
        <p className="field__error md:text-center" role="alert">
          {avatar.error}
        </p>
      )}
    </div>
  )
}
