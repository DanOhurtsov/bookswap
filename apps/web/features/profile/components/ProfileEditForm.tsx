'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useRef } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { PROFILE_LIMITS, type Me } from '@bookswap/shared'
import { LoaderCircle } from 'lucide-react'
import { FormStatus } from '@/components/Form/FormStatus'
import { TextAreaField, TextField } from '@/components/Form/FormFields'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BIO_WARN_FROM,
  normalizeHandleInput,
  profileChanges,
  profileFormSchema,
  toProfileFormValues,
} from '../model/profile-form'
import type { ProfileStat } from '../model/profile-view'
import { useAvatarUpload } from '../model/use-avatar-upload'
import { useHandleAvailability } from '../model/use-handle-availability'
import { useProfileSave } from '../model/use-profile-save'
import { useUnsavedChanges } from '../model/use-unsaved-changes'
import { AvatarPicker } from './AvatarPicker'
import { ProfileStats } from './ProfileHero'
import { PROFILE_ACTION, PROFILE_CTA, ProfileCard } from './ProfileParts'

/** Where the form returns to — after a save, a cancel, or when nothing changed. */
const PROFILE_HREF = '/profile'

/**
 * `/profile/edit` (BS-148, canvas «режим редагування»): the profile card turns into the form; the rest
 * of the page stays as it is.
 *
 * The draft lives only in this form's React Hook Form state: nothing outside sees it until the server
 * has accepted it. The photo is the exception — it is saved the moment it is chosen (`AvatarPicker`).
 * The form is left with `replace`, so Back from the profile does not reopen a finished edit.
 */
export function ProfileEditForm({
  user,
  stats,
  onSaved,
}: {
  user: Me
  stats: ProfileStat[] | undefined
  onSaved: (changes: Partial<Me>) => void
}) {
  const router = useRouter()
  const {
    control,
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isDirty },
  } = useForm({
    resolver: zodResolver(profileFormSchema),
    defaultValues: toProfileFormValues(user),
    // Checked when a field is left and on «Зберегти»; an error goes as soon as it is being fixed.
    mode: 'onBlur',
    reValidateMode: 'onBlur',
  })
  const handle = useWatch({ control, name: 'handle' })
  const bio = useWatch({ control, name: 'bio' })

  const leave = () => {
    router.replace(PROFILE_HREF)
  }
  const handleCheck = useHandleAvailability(user.id, user.handle, handle)
  const save = useProfileSave({
    onSaved,
    leave,
    onHandleTaken: (message) => {
      setError('handle', { type: 'server', message }, { shouldFocus: true })
    },
  })
  const unsaved = useUnsavedChanges({ dirty: isDirty, locked: save.saving, leave })
  const avatar = useAvatarUpload(onSaved)

  const handleError = errors.handle?.message
  // Only a problem is shown under the nickname: the quiet states («поточний», «перевіряємо», «вільний»)
  // stay silent, and «Зберегти» still waits for them (product decision, 27.10.2026).
  const handleProblem =
    handleError ?? (handleCheck.tone === 'error' ? handleCheck.message : undefined)
  const blocked = save.saving || handleCheck.blocksSave || handleError !== undefined

  const submit = handleSubmit((values) => {
    if (blocked) return

    const changes = profileChanges(values, user)

    // Only spaces were added, or a field was typed back: there is nothing to send.
    if (changes === null) leave()
    else save.save(changes)
  })

  const keepEditingButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  return (
    <ProfileCard aria-labelledby="profile-edit-title" className="p-6 md:p-8">
      <h1 id="profile-edit-title" className="sr-only">
        Редагування профілю
      </h1>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        {/* The whole form is locked while PATCH /me is in flight, not only its buttons: an edit made
            after «Зберегти» would not be in the request, and the answer closes the form — the edit
            would vanish silently. A disabled <fieldset>, not RHF's own `disabled`: that one drops the
            values from submit. */}
        <fieldset
          disabled={save.saving}
          className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0 md:flex-row md:gap-7"
        >
          <AvatarPicker user={user} avatar={avatar} />

          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {save.failure?.kind === 'connection' && (
              <div className="alert alert--error" role="alert">
                <p>Не вдалося зберегти. Перевірте з’єднання — введені дані нікуди не зникнуть.</p>
                <button
                  type="button"
                  onClick={() => {
                    void submit()
                  }}
                >
                  Спробувати ще
                </button>
              </div>
            )}
            {save.failure?.kind === 'request' && <FormStatus error={save.failure.error} />}

            {/* `items-start`: the nickname's status line makes its cell taller, and a stretched `.field`
                (itself a grid) would spread the name's label and input over that height.
                On two columns the nickname spans two rows: its error and retry fill the empty cell
                beside «Місто» instead of growing the first row and pushing «Місто» down. */}
            <div className="grid items-start gap-x-5 gap-y-4 md:grid-cols-2">
              <TextField
                id="displayName"
                label="Ім’я"
                autoComplete="name"
                required
                error={errors.displayName?.message}
                {...register('displayName', {
                  onChange: () => {
                    clearErrors('displayName')
                  },
                })}
              />

              <div className="field md:row-span-2">
                <label htmlFor="handle">Нік</label>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-(--bookswap-muted)"
                  >
                    @
                  </span>
                  <Controller
                    control={control}
                    name="handle"
                    render={({ field }) => (
                      <input
                        id="handle"
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        aria-describedby={handleProblem === undefined ? undefined : 'handle-error'}
                        aria-invalid={handleProblem !== undefined}
                        // `.field input` sets the padding outside any layer: only inline beats it.
                        style={{ paddingLeft: '1.75rem' }}
                        onBlur={field.onBlur}
                        onChange={(event) => {
                          clearErrors('handle')
                          field.onChange(normalizeHandleInput(event.target.value))
                        }}
                      />
                    )}
                  />
                </div>
                {handleProblem !== undefined && (
                  <p className="field__error" id="handle-error" role="alert">
                    {handleProblem}
                  </p>
                )}
                {handleError === undefined && handleCheck.canRetry && (
                  <button
                    type="button"
                    className="button--link m-0 justify-self-start"
                    onClick={handleCheck.retry}
                  >
                    Перевірити ще раз
                  </button>
                )}
              </div>

              <TextField
                id="city"
                label="Місто (необов’язково)"
                autoComplete="address-level2"
                maxLength={PROFILE_LIMITS.cityMax}
                error={errors.city?.message}
                {...register('city', {
                  onChange: () => {
                    clearErrors('city')
                  },
                })}
              />

              <div className="flex flex-col gap-1 md:col-span-2">
                <TextAreaField
                  id="bio"
                  label="Про себе (необов’язково)"
                  rows={3}
                  maxLength={PROFILE_LIMITS.bioMax}
                  error={errors.bio?.message}
                  {...register('bio', {
                    onChange: () => {
                      clearErrors('bio')
                    },
                  })}
                />
                <span
                  className={cn(
                    'self-end text-[0.85rem]',
                    bio.length >= BIO_WARN_FROM ? 'text-(--warn)' : 'text-(--bookswap-muted)',
                  )}
                >
                  {bio.length}/{PROFILE_LIMITS.bioMax}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2.5">
              <Button
                ref={cancelButton}
                type="button"
                variant="outline"
                className={PROFILE_ACTION}
                onClick={unsaved.cancel}
              >
                Скасувати
              </Button>
              <Button type="submit" disabled={!isDirty || blocked} className={PROFILE_CTA}>
                {save.saving && (
                  <LoaderCircle aria-hidden="true" className="size-[18px] animate-spin" />
                )}
                {save.saving ? 'Зберігаємо…' : 'Зберегти'}
              </Button>
            </div>
          </div>
        </fieldset>
      </form>

      {/* The question takes focus when it opens; when it closes, focus goes back to «Скасувати». */}
      <AlertDialog
        open={unsaved.confirming}
        onOpenChange={(open) => {
          if (!open) unsaved.keepEditing()
        }}
      >
        <AlertDialogContent initialFocus={keepEditingButton} finalFocus={cancelButton}>
          <AlertDialogHeader>
            <AlertDialogTitle>Скасувати зміни?</AlertDialogTitle>
            <AlertDialogDescription>Внесене не збережеться.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={keepEditingButton}>Продовжити редагування</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={unsaved.discard}>
              Скасувати зміни
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProfileStats stats={stats} />
    </ProfileCard>
  )
}
