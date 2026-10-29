'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import type { Me } from '@bookswap/shared'
import { useSession } from '@/app/lib/use-session'
import { FormStatus } from '@/components/Form/FormStatus'
import { Skeleton } from '@/components/ui/skeleton'
import { useInviteLink } from '../model/use-invite-link'
import { useProfileSettings } from '../model/use-profile-settings'
import { useProfileSummary } from '../model/use-profile-summary'
import { AccountCard } from './AccountCard'
import { FriendsCard } from './FriendsCard'
import { LendingSettingsCard } from './LendingSettingsCard'
import { ProfileActivity } from './ProfileActivity'
import { ProfileEditForm } from './ProfileEditForm'
import { ProfileHero } from './ProfileHero'
import { ProfileShelf } from './ProfileShelf'
import { ReliabilityCard } from './ReliabilityCard'

/** `/profile` shows the profile; `/profile/edit` puts the edit form in place of its card. */
export type ProfileMode = 'view' | 'edit'

/**
 * `/profile` and `/profile/edit`: the signed-in user's own profile. The guard lives here, the profile
 * below it, so nothing reads a summary, saves a setting or checks a nickname before there is an owner.
 * Every state is a `.profile-theme` page, the loading one too: the profile palette (globals.css) holds
 * from the first paint on.
 */
export function ProfileScreen({ mode = 'view' }: { mode?: ProfileMode }) {
  const router = useRouter()
  const { state, updateUser } = useSession()

  // Захист сторінки: гостя відправляємо на логін, щойно це стало відомо.
  useEffect(() => {
    if (state.status === 'guest') router.replace('/login')
  }, [state.status, router])

  if (state.status === 'loading') {
    return (
      <main className="page profile-theme">
        <h1>Профіль</h1>
        <p className="status status--pending">Завантажую профіль…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page profile-theme">
        <h1>Профіль</h1>
        <FormStatus error={new Error(state.message)} />
      </main>
    )
  }

  if (state.status === 'guest') {
    return (
      <main className="page profile-theme">
        <h1>Профіль</h1>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </main>
    )
  }

  // Keyed by user: another account in the same tab is another profile, not an edit of this one.
  return (
    <ProfileContent key={state.user.id} mode={mode} user={state.user} updateUser={updateUser} />
  )
}

type ProfileContentProps = {
  mode: ProfileMode
  user: Me
  updateUser: (userId: string, changes: Partial<Me>) => void
}

/**
 * BS-148: the profile page (canvas «Profile Page»). The card and the settings render from the session
 * at once; the numbers, books, activity, reliability and friends come with one summary request. The
 * invite and settings controllers live here because two places on the page share each of them.
 */
function ProfileContent({ mode, user, updateUser }: ProfileContentProps) {
  const summary = useProfileSummary(user.id)
  const invite = useInviteLink()
  // Every save here is about this user: its answer reaches the session only while they are signed in.
  const onSaved = (changes: Partial<Me>) => {
    updateUser(user.id, changes)
  }
  const settings = useProfileSettings(user, onSaved)
  const { view } = summary
  const stats = view.kind === 'ready' ? view.stats : undefined

  return (
    // The canvas container is 1120 px; `.page` keeps the app's gutters around it.
    <main className="page profile-theme">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
        {mode === 'edit' ? (
          <ProfileEditForm user={user} stats={stats} onSaved={onSaved} />
        ) : (
          <ProfileHero user={user} stats={stats} invite={invite} />
        )}

        {view.kind === 'error' && (
          <div className="alert alert--error" role="alert">
            <p>{view.message}</p>
            <button type="button" onClick={summary.retry}>
              Спробувати ще
            </button>
          </div>
        )}

        <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-10">
            {view.kind === 'ready' ? (
              <>
                <ProfileShelf books={view.books} />
                <ProfileActivity lines={view.activity} />
              </>
            ) : (
              view.kind === 'loading' && <SummaryPlaceholder />
            )}
          </div>

          {/* `minmax(0, 1fr)`: a track sized by its content let the friends rail widen the page. */}
          <aside className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 lg:flex lg:w-[336px] lg:shrink-0 lg:flex-col">
            {view.kind === 'ready' && (
              <>
                <ReliabilityCard reliability={view.reliability} />
                <FriendsCard friends={view.friends} invite={invite} />
              </>
            )}
            <div className="md:col-span-2">
              <LendingSettingsCard settings={settings} />
            </div>
            <div className="md:col-span-2">
              <AccountCard
                email={user.email}
                emailVerified={user.emailVerified}
                settings={settings}
              />
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}

/** The shape of the books and activity while the summary loads, so the page does not jump. */
function SummaryPlaceholder() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-10">
      <Skeleton className="h-72" />
      <Skeleton className="h-64" />
    </div>
  )
}
