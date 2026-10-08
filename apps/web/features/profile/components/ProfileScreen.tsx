'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { Me } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { FormStatus } from '@/components/Form/FormStatus'
import { resendEmailVerification } from '../api/profile-requests'
import { ProfileEditForm } from './ProfileEditForm'
import { ProfileView } from './ProfileView'

/**
 * `/profile`: the signed-in user's own profile. The guard lives here, the profile below it, so
 * nothing renders an editor before there is an owner to edit.
 */
export function ProfileScreen() {
  const router = useRouter()
  const { state, setUser } = useSession()

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

  // Keyed by user: another account in the same tab is another profile, not an edit of this one.
  return <ProfileContent key={state.user.id} user={state.user} onUpdated={setUser} />
}

type ProfileContentProps = {
  user: Me
  onUpdated: (user: Me) => void
}

/**
 * Picks the mode (CLAUDE.md, "modes are components"). What must outlive a switch lives here:
 * "this was just saved", and — via `EmailVerificationNotice` staying mounted — "the letter is sent".
 */
function ProfileContent({ user, onUpdated }: ProfileContentProps) {
  const [editing, setEditing] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  return (
    <main className="page page--narrow">
      <h1>Профіль</h1>
      <p className="lede">{user.email}</p>

      {!user.emailVerified && <EmailVerificationNotice />}

      {editing ? (
        <ProfileEditForm
          user={user}
          onSaved={(updated) => {
            onUpdated(updated)
            setEditing(false)
            setJustSaved(true)
          }}
          onCancel={() => {
            setEditing(false)
          }}
        />
      ) : (
        <>
          {justSaved && <FormStatus success="Зміни збережено." />}
          <ProfileView
            user={user}
            onEdit={() => {
              setJustSaved(false)
              setEditing(true)
            }}
          />
        </>
      )}
    </main>
  )
}

function EmailVerificationNotice() {
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<unknown>()

  async function resend(): Promise<void> {
    setFailure(undefined)

    try {
      await resendEmailVerification()
      setSent(true)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    }
  }

  return (
    <>
      <div className="alert alert--warn" role="status">
        <p>Адресу ще не підтверджено.</p>
        {sent ? (
          <p>Лист надіслано — перевірте пошту.</p>
        ) : (
          <button type="button" className="button--link" onClick={() => void resend()}>
            Надіслати лист ще раз
          </button>
        )}
      </div>
      <FormStatus error={failure} />
    </>
  )
}
