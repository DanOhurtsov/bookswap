'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useState, type FormEvent } from 'react'
import { useForm } from 'react-hook-form'
import { PROFILE_LIMITS, VISIBILITY, type Me, type UpdateProfileRequest } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { SelectField, TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { updateProfile } from '../api/profile-requests'
import { VISIBILITY_LABELS, profileFormSchema, toProfileFormValues } from '../model/profile-form'

type ProfileEditFormProps = {
  user: Me
  onSaved: (user: Me) => void
  onCancel: () => void
}

/**
 * The draft lives only in this form's React Hook Form state: nothing outside sees it until the
 * server has accepted it, so the view and the session keep the saved profile while the user types.
 * Mounted afresh for every edit session, which is what makes "Скасувати" drop the draft and its
 * errors.
 */
export function ProfileEditForm({ user, onSaved, onCancel }: ProfileEditFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(profileFormSchema),
    defaultValues: toProfileFormValues(user),
  })
  const [failure, setFailure] = useState<unknown>()

  async function save(body: UpdateProfileRequest): Promise<void> {
    try {
      onSaved(await updateProfile(body))
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    if (isSubmitting) {
      event.preventDefault()
      return
    }

    setFailure(undefined)
    void handleSubmit(save)(event)
  }

  return (
    <form onSubmit={submit} noValidate>
      {/* The whole form is locked while PATCH /me is in flight, not only its buttons: an edit made
          after «Зберегти» would not be in the request, and the answer closes the form — the edit
          would vanish silently. A second save or a cancel would race that same answer.
          A disabled <fieldset>, not RHF's own `disabled`: that one drops the values from submit. */}
      <fieldset disabled={isSubmitting} className="form">
        <FormStatus error={failure} />

        <TextField
          id="displayName"
          label="Імʼя"
          autoComplete="name"
          required
          error={errors.displayName?.message}
          {...register('displayName')}
        />

        <TextField
          id="avatarUrl"
          label="Посилання на аватар"
          type="url"
          inputMode="url"
          placeholder="https://…"
          hint="Порожнє поле прибере аватар."
          error={errors.avatarUrl?.message}
          {...register('avatarUrl')}
        />

        <TextAreaField
          id="bio"
          label="Про себе"
          rows={4}
          maxLength={PROFILE_LIMITS.bioMax}
          hint={`До ${String(PROFILE_LIMITS.bioMax)} символів.`}
          error={errors.bio?.message}
          {...register('bio')}
        />

        <SelectField
          id="libraryVisibility"
          label="Видимість бібліотеки за замовчуванням"
          error={errors.libraryVisibility?.message}
          {...register('libraryVisibility')}
        >
          {VISIBILITY.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <div className="field field--checkbox">
          <input id="showHolderNames" type="checkbox" {...register('showHolderNames')} />
          <label htmlFor="showHolderNames">Друзі бачитимуть, хто читає мої книжки</label>
        </div>

        <div className="actions">
          <button type="submit">{isSubmitting ? 'Зберігаю…' : 'Зберегти'}</button>
          <button type="button" className="button--ghost" onClick={onCancel}>
            Скасувати
          </button>
        </div>
      </fieldset>
    </form>
  )
}
