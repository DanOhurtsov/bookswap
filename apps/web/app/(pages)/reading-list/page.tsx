'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { FormStatus } from '@/components/Form/FormStatus'
import { ReadingListScreen } from '@/features/reading-status/index.client'
import { useSession } from '../../lib/use-session'

/** Stage 10, 10j.2: the viewer's private reading list. `ReadingListScreen` mounts only for a signed-in viewer. */
export default function ReadingListPage() {
  const router = useRouter()
  const { state } = useSession()

  useEffect(() => {
    if (state.status === 'guest') router.replace('/login')
  }, [state.status, router])

  if (state.status === 'error') {
    return (
      <main className="page">
        <h1>Список читання</h1>
        <FormStatus error={new Error(state.message)} />
      </main>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <main className="page">
        <h1>Список читання</h1>
        <p className="status status--pending">Перевіряю сесію…</p>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Список читання</h1>
      {/* Keyed by viewer: another user's session must never see this list, not even for one frame. */}
      <ReadingListScreen key={state.user.id} />
    </main>
  )
}
