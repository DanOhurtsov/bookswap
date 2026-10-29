'use client'

import Link from 'next/link'
import { useState } from 'react'
import { VISIBILITY, type Visibility } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { FormStatus } from '@/components/Form/FormStatus'
import { SelectField, labelledOptions } from '@/components/Form/FormFields'
import { SwitchRow } from '@/components/ui/switch'
import { resendEmailVerification } from '../api/profile-requests'
import type { ProfileSettingsController } from '../model/use-profile-settings'
import { ProfileCard } from './ProfileParts'

/** The profile's own wording: it says who sees the library, not only the value's name. */
const VISIBILITY_LABELS: Record<Visibility, string> = {
  PUBLIC: 'Публічна — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватна — тільки я',
}

const VISIBILITY_OPTIONS = labelledOptions(VISIBILITY, VISIBILITY_LABELS)

const FIELDS = ['libraryVisibility', 'showHolderNames'] as const

/**
 * What PROF-01 keeps on the page and the canvas has no place for: the email and its confirmation,
 * the library's default visibility and whether friends see who has my books. The two settings are
 * saved at once, as the lending ones beside them.
 */
export function AccountCard({
  email,
  emailVerified,
  settings,
}: {
  email: string
  emailVerified: boolean
  settings: ProfileSettingsController
}) {
  const { shown, save, saving } = settings
  const error = settings.errorFor(FIELDS)

  return (
    <ProfileCard aria-labelledby="profile-account" className="flex flex-col gap-3 px-6 py-5">
      <h2 id="profile-account" className="m-0 text-lg leading-[26px] font-semibold">
        Акаунт
      </h2>
      <p className="m-0 text-[15px] break-all">{email}</p>

      {!emailVerified && <EmailVerificationNotice />}

      <SelectField
        id="profile-library-visibility"
        label="Видимість бібліотеки за замовчуванням"
        value={shown.libraryVisibility}
        options={VISIBILITY_OPTIONS}
        disabled={saving}
        onValueChange={(libraryVisibility) => {
          save({ libraryVisibility })
        }}
      />
      <SwitchRow
        label="Друзі бачитимуть, хто читає мої книжки"
        checked={shown.showHolderNames}
        disabled={saving}
        onCheckedChange={(showHolderNames) => {
          save({ showHolderNames })
        }}
      />

      {error !== undefined && (
        <p role="alert" className="m-0 text-sm text-(--error)">
          {error}
        </p>
      )}

      <Link className="link-underline self-start" href="/notifications/settings">
        Налаштування сповіщень
      </Link>
    </ProfileCard>
  )
}

/** Once sent, the notice says so for as long as the profile page stays open. */
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
