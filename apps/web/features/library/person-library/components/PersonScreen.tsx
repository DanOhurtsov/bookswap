'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import type { PublicUser } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { personHref } from '@/app/lib/person-href'
import { useSession } from '@/app/lib/use-session'
import { usePerson, type PersonLookup } from '../model/use-person'
import { PersonLibrary, PersonShell } from './PersonLibrary'

/** `/u/<handle>` (BS-148): the person's library, found by their nickname. */
export function PersonScreen({ handle }: { handle: string }) {
  return (
    <PersonGate lookup={{ handle }}>{(person) => <PersonLibrary ownerId={person.id} />}</PersonGate>
  )
}

/**
 * `/users/<id>/library`, the address before BS-148: finds the person's nickname and replaces the
 * address with `/u/<handle>`, so the old link lands on the same page without a history entry.
 */
export function LegacyPersonRedirect({ userId }: { userId: string }) {
  return (
    <PersonGate lookup={{ id: userId }}>
      {(person) => <Redirect href={personHref(person)} />}
    </PersonGate>
  )
}

function Redirect({ href }: { href: string }) {
  const router = useRouter()

  useEffect(() => {
    router.replace(href)
  }, [router, href])

  return (
    <PersonShell title="Бібліотека">
      <p className="status status--pending">Завантажую…</p>
    </PersonShell>
  )
}

/**
 * The guard both addresses share: a signed-in viewer first, then the person the address names.
 * `children` render only with a person in hand, so nothing below asks for a library by an id that
 * is not known yet.
 */
function PersonGate({
  lookup,
  children,
}: {
  lookup: PersonLookup
  children: (person: PublicUser) => ReactNode
}) {
  const router = useRouter()
  const { state: session, reload: reloadSession } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <PersonShell title="Бібліотека">
        <p className="status status--pending">Завантажую…</p>
      </PersonShell>
    )
  }

  // A failed session check is NOT "you are signed out": only `guest` redirects. Showing
  // «Переадресовую…» here would leave the person in front of a promise that never comes true.
  if (session.status === 'error') {
    return (
      <PersonShell title="Бібліотека">
        <FormStatus error={new Error(session.message)} />
        <p className="form__aside">
          <button type="button" onClick={reloadSession}>
            Спробувати ще раз
          </button>{' '}
          · <Link href="/login">Увійти</Link>
        </p>
      </PersonShell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <PersonShell title="Бібліотека">
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </PersonShell>
    )
  }

  // Keyed by viewer: whether a pair is blocked depends on who asks, so another account on the same
  // tab is another lookup, not a transition of this one.
  return (
    <PersonFound key={session.user.id} lookup={lookup}>
      {children}
    </PersonFound>
  )
}

function PersonFound({
  lookup,
  children,
}: {
  lookup: PersonLookup
  children: (person: PublicUser) => ReactNode
}) {
  const state = usePerson(lookup)

  if (state.status === 'loading') {
    return (
      <PersonShell title="Бібліотека">
        <p className="status status--pending">Завантажую…</p>
      </PersonShell>
    )
  }

  if (state.status !== 'ready') {
    return (
      <PersonShell title="Бібліотека">
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <Link href="/friends">До друзів</Link>
        </p>
      </PersonShell>
    )
  }

  return children(state.person)
}
