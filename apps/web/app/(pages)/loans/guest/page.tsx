'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { FormStatus } from '@/components/Form/FormStatus'
import { GuestLoansScreen } from '@/features/guest-loans/index.client'
import { useSession } from '../../../lib/use-session'

/**
 * Stage 10, 10f.3. Owner-only, той самий прийом, що `/contacts` (10f.2): маршрут існує лише поки
 * сервер повідомляє `features.guestLoans === true`. При вимкненому прапорі сторінка виглядає як
 * невідомий маршрут і `GuestLoansScreen` не монтується взагалі — жодного гостьового запиту.
 */
export default function GuestLoansPage() {
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
      <h1>Гостьові позики</h1>
      <GuestLoansScreen />
    </main>
  )
}
