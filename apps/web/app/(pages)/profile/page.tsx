'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import {
  PROFILE_LIMITS,
  VISIBILITY,
  acceptedResponseSchema,
  meSchema,
  updateProfileRequestSchema,
  type Me,
  type Visibility,
} from '@bookswap/shared'
import { SelectField, TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../lib/api'
import { useSession } from '../../lib/use-session'
import { validate, type FieldErrors } from '../../lib/validation'

const VISIBILITY_LABELS: Record<Visibility, string> = {
  PUBLIC: 'Публічна — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватна — тільки я',
}

export default function ProfilePage() {
  const router = useRouter()
  const { state, setUser, setGuest } = useSession()

  // Захист сторінки: гостя відправляємо на логін, щойно це стало відомо.
  useEffect(() => {
    if (state.status === 'guest') router.replace('/login')
  }, [state.status, router])

  if (state.status === 'loading') {
    return (
      <main className="page">
        <h1>Профіль</h1>
        <p className="status status--pending">Завантажую профіль…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page">
        <h1>Профіль</h1>
        <FormStatus error={new Error(state.message)} />
      </main>
    )
  }

  if (state.status === 'guest') {
    return (
      <main className="page">
        <h1>Профіль</h1>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </main>
    )
  }

  return <ProfileForm user={state.user} onUpdated={setUser} onLoggedOut={setGuest} />
}

function ProfileForm({
  user,
  onUpdated,
  onLoggedOut,
}: {
  user: Me
  onUpdated: (user: Me) => void
  onLoggedOut: () => void
}) {
  const router = useRouter()
  const [fields, setFields] = useState({
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? '',
    bio: user.bio ?? '',
    libraryVisibility: user.libraryVisibility,
    showHolderNames: user.showHolderNames,
  })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>()
  const [saved, setSaved] = useState<string>()
  const [pending, setPending] = useState(false)
  const [verificationSent, setVerificationSent] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFailure(undefined)
    setSaved(undefined)

    // Порожній рядок означає «прибрати», а не «зберегти порожнечу» — API розрізняє
    // null і відсутність поля, і форма мусить говорити тією ж мовою.
    const result = validate(updateProfileRequestSchema, {
      displayName: fields.displayName,
      avatarUrl: fields.avatarUrl.trim() === '' ? null : fields.avatarUrl.trim(),
      bio: fields.bio.trim() === '' ? null : fields.bio,
      libraryVisibility: fields.libraryVisibility,
      showHolderNames: fields.showHolderNames,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setPending(true)

    try {
      const updated = await apiRequest('/me', {
        method: 'PATCH',
        body: result.data,
        schema: meSchema,
      })

      onUpdated(updated)
      setSaved('Зміни збережено.')
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setPending(false)
    }
  }

  async function resendVerification(): Promise<void> {
    setFailure(undefined)

    try {
      await apiRequest('/auth/email-verification', {
        method: 'POST',
        schema: acceptedResponseSchema,
      })

      setVerificationSent(true)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    }
  }

  async function logout(): Promise<void> {
    setFailure(undefined)

    try {
      await apiRequest('/auth/logout', { method: 'POST' })
    } catch (error) {
      // A failed logout must not be mistaken for a confirmed one — the user
      // is still signed in, and this page (and everything else reading the
      // shared session) has to keep saying so, not silently redirect them to
      // `/login` while their cookie is still valid.
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      return
    }

    // Shared session (§8e-3 follow-up): sets `guest` directly through the
    // SAME context every other mounted component reads — `NavBar` and
    // anything else on screen drop the old identity immediately, without
    // waiting on (or depending on the outcome of) a fresh `/auth/session` GET.
    onLoggedOut()
    router.replace('/login')
  }

  return (
    <main className="page page--narrow">
      <h1>Профіль</h1>
      <p className="lede">{user.email}</p>

      {!user.emailVerified && (
        <div className="alert alert--warn" role="status">
          <p>Адресу ще не підтверджено.</p>
          {verificationSent ? (
            <p>Лист надіслано — перевірте пошту.</p>
          ) : (
            <button
              type="button"
              className="button--link"
              onClick={() => void resendVerification()}
            >
              Надіслати лист ще раз
            </button>
          )}
        </div>
      )}

      <FormStatus error={failure} success={saved} />

      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          id="displayName"
          label="Імʼя"
          name="displayName"
          autoComplete="name"
          required
          value={fields.displayName}
          error={errors.displayName}
          onChange={(event) => {
            setFields({ ...fields, displayName: event.target.value })
          }}
        />

        <TextField
          id="avatarUrl"
          label="Посилання на аватар"
          name="avatarUrl"
          type="url"
          inputMode="url"
          placeholder="https://…"
          hint="Порожнє поле прибере аватар."
          value={fields.avatarUrl}
          error={errors.avatarUrl}
          onChange={(event) => {
            setFields({ ...fields, avatarUrl: event.target.value })
          }}
        />

        <TextAreaField
          id="bio"
          label="Про себе"
          name="bio"
          rows={4}
          maxLength={PROFILE_LIMITS.bioMax}
          hint={`До ${String(PROFILE_LIMITS.bioMax)} символів.`}
          value={fields.bio}
          error={errors.bio}
          onChange={(event) => {
            setFields({ ...fields, bio: event.target.value })
          }}
        />

        <SelectField
          id="libraryVisibility"
          label="Видимість бібліотеки за замовчуванням"
          name="libraryVisibility"
          value={fields.libraryVisibility}
          error={errors.libraryVisibility}
          onChange={(event) => {
            setFields({ ...fields, libraryVisibility: event.target.value as Visibility })
          }}
        >
          {VISIBILITY.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <div className="field field--checkbox">
          <input
            id="showHolderNames"
            name="showHolderNames"
            type="checkbox"
            checked={fields.showHolderNames}
            onChange={(event) => {
              setFields({ ...fields, showHolderNames: event.target.checked })
            }}
          />
          <label htmlFor="showHolderNames">Показувати друзям, у кого зараз мої книжки</label>
        </div>

        <button type="submit" disabled={pending}>
          {pending ? 'Зберігаю…' : 'Зберегти'}
        </button>
      </form>

      <p className="form__aside">
        {/* §6.1 називає підключення Telegram і налаштування сповіщень частиною
            профілю; сама сторінка окрема, бо матриця §7.6 більша за решту форми. */}
        <Link href="/notifications/settings">Сповіщення й Telegram</Link> ·{' '}
        <Link href="/friends">Друзі</Link> · <Link href="/library">Моя бібліотека</Link> ·{' '}
        <button type="button" className="button--link" onClick={() => void logout()}>
          Вийти
        </button>{' '}
        · <Link href="/">На головну</Link>
      </p>
    </main>
  )
}
