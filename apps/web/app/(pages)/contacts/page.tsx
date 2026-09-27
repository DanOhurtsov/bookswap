'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { FormStatus } from '@/components/Form/FormStatus'
import { ContactsScreen } from '@/features/contacts/index.client'
import { useSession } from '../../lib/use-session'

/**
 * Stage 10, 10f.2. Private contacts exist only while the server reports the feature on;
 * otherwise the page renders like an unknown route and never mounts `ContactsScreen`,
 * so no contact request is sent.
 */
export default function ContactsPage() {
  const router = useRouter()
  const { state } = useSession()

  useEffect(() => {
    if (state.status === 'guest') router.replace('/login')
  }, [state.status, router])

  if (state.status === 'error') {
    return (
      <main className="page">
        <FormStatus error={new Error(state.message)} />
      </main>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <main className="page">
        <p className="status status--pending">Перевіряю сесію…</p>
      </main>
    )
  }

  if (state.features?.guestLoans !== true) {
    return (
      <main className="page">
        <h1>Сторінку не знайдено</h1>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Контакти</h1>
      <ContactsScreen />
    </main>
  )
}
