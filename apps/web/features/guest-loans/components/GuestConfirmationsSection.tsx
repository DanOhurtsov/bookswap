'use client'

import Link from 'next/link'
import { useState } from 'react'
import type {
  GuestLoanConfirmation,
  IssueGuestConfirmationLinkRequest,
  UpdateGuestLoanConfirmationRequest,
} from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { useGuestConfirmation, useGuestConfirmations } from '@/app/lib/use-guest-confirmations'
import {
  actOnGuestConfirmation,
  issueGuestConfirmationLink,
} from '../api/guest-confirmation-requests'
import { GuestConfirmationCard } from './GuestConfirmationCard'
import type { IssuedLink } from './GuestConfirmationLinkPanel'

/**
 * Механіка дій над запитами: як у `useGuestLoanActions` — дані перечитуються і на успіху, і на помилці
 * (конкурентна дія, 409/404, має одразу показати свіжу картку). Щойно видане посилання живе лише тут, у
 * пам'яті (токен приходить один раз).
 */
function useConfirmationActions(reload: () => Promise<void>) {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [issued, setIssued] = useState<Record<string, IssuedLink>>({})

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    setFailure(undefined)
    setBusyKey(key)

    let ok = false

    try {
      await action()
      ok = true
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      await reload()
      setBusyKey(undefined)
    }

    return ok
  }

  const act = (
    confirmation: GuestLoanConfirmation,
    body: UpdateGuestLoanConfirmationRequest,
  ): Promise<void> =>
    run(`${body.action}:${confirmation.id}`, async () => {
      await actOnGuestConfirmation(confirmation.id, body)
      // Рішення власника гасить посилання (сервер) — і показаний токен теж прибираємо.
      setIssued(({ [confirmation.id]: _dropped, ...rest }) => rest)
    }).then(() => undefined)

  const issue = (
    confirmation: GuestLoanConfirmation,
    body: IssueGuestConfirmationLinkRequest,
  ): Promise<boolean> =>
    run(`link-${body.delivery === 'COPY' ? 'copy' : 'email'}:${confirmation.id}`, async () => {
      // Щойно починається повторна видача, показаний раніше URL прибираємо ОДРАЗУ: сервер міг уже
      // погасити його (навіть якщо ця видача чи лист упали), а за станом `link` про чинність старого
      // токена судити не можна. Після помилки він не повертається — його більше немає в стані.
      setIssued(({ [confirmation.id]: _dropped, ...rest }) => rest)

      const result = await issueGuestConfirmationLink(confirmation.id, body)

      // Нова видача замінює попередню (сервер погасив старе посилання) — те, що бачив власник, теж.
      setIssued((current) => ({
        ...current,
        [confirmation.id]:
          result.delivery === 'COPY' && result.url !== null
            ? { delivery: 'COPY', url: result.url }
            : { delivery: 'EMAIL' },
      }))
    })

  return { failure, busyKey, issued, act, issue }
}

function Cards({
  confirmations,
  actions,
}: {
  confirmations: readonly GuestLoanConfirmation[]
  actions: ReturnType<typeof useConfirmationActions>
}) {
  return (
    <ul className="books">
      {confirmations.map((confirmation) => (
        <GuestConfirmationCard
          key={confirmation.id}
          confirmation={confirmation}
          busyKey={actions.busyKey}
          issued={actions.issued[confirmation.id]}
          onAct={actions.act}
          onIssue={actions.issue}
        />
      ))}
    </ul>
  )
}

/** Розділ «Запити підтвердження» на `/loans/guest`: усі п'ять станів запиту. */
export function GuestConfirmationsSection() {
  const { state, reload } = useGuestConfirmations()
  const actions = useConfirmationActions(reload)

  return (
    <section aria-labelledby="guest-confirmations-heading">
      <h2 id="guest-confirmations-heading">Запити підтвердження</h2>
      <p className="form__aside">
        Запит просить гостя підтвердити, що він отримав саме цю книжку. Гість відповідає за
        посиланням без акаунта; відповідь — це не доведена особа, а відповідь після підтвердження
        контролю введеного ним email.
      </p>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую запити…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.confirmations.length === 0 && (
        <p className="empty">
          Запитів підтвердження поки немає. Створити його можна з картки примірника в{' '}
          <Link href="/library">бібліотеці</Link>.
        </p>
      )}

      {state.status === 'ready' && (
        <Cards confirmations={state.data.confirmations} actions={actions} />
      )}
    </section>
  )
}

/** `?confirmationId=`: один запит (з посилання сповіщення й після створення в бібліотеці). */
export function SingleGuestConfirmationView({ confirmationId }: { confirmationId: string }) {
  const { state, reload } = useGuestConfirmation(confirmationId)
  const actions = useConfirmationActions(reload)

  return (
    <>
      <p className="form__aside">
        Один запит підтвердження. <Link href="/loans/guest">Показати всі</Link>
      </p>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && (
        <>
          <FormStatus error={new Error(state.message)} />
          <p className="empty">Можливо, цього запиту більше немає або він вам не належить.</p>
        </>
      )}

      {state.status === 'ready' && (
        <Cards confirmations={[state.data.confirmation]} actions={actions} />
      )}
    </>
  )
}
