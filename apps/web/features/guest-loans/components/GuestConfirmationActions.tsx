'use client'

import { useState } from 'react'
import type { GuestLoanConfirmation, UpdateGuestLoanConfirmationRequest } from '@bookswap/shared'
import { ConfirmDialog } from '@/components/ConfirmDialog'

interface GuestConfirmationActionsProps {
  confirmation: GuestLoanConfirmation
  busy: boolean
  busyKey: string | undefined
  onAct: (
    confirmation: GuestLoanConfirmation,
    body: UpdateGuestLoanConfirmationRequest,
  ) => Promise<void>
}

/**
 * Stage 10 (10i.3): дії власника над незавершеним запитом (`OPEN`, `DENIED`) — дві й лише дві (10i.1):
 *
 * - «Скасувати помилкову передачу» — лише за явною заявою, що книжка фізично в власника (`bookIsWithOwner`).
 *   Тільки ця дія звільняє `Copy`; заперечення гостя саме по собі — не повернення й нічого не звільняє (Q25).
 * - «Залишити зі слів власника» — позика лишається активною як запис лише з ваших слів; вона НЕ стає
 *   «підтвердженою гостем» (Q27) і не маскується під відповідь гостя.
 *
 * Якщо книжки в власника немає, «скасувати» не пропонується як вихід: примірник лишається недоступним
 * до окремого запису факту (повернення, втрата, запис зі слів) — після «Залишити зі слів власника» це
 * робиться звичайними діями гостьової позики.
 */
export function GuestConfirmationActions({
  confirmation,
  busy,
  busyKey,
  onAct,
}: GuestConfirmationActionsProps) {
  const [confirming, setConfirming] = useState<'cancel' | 'record'>()

  if (confirmation.status !== 'OPEN' && confirmation.status !== 'DENIED') return null

  const label = (action: string, idle: string): string =>
    busyKey === `${action}:${confirmation.id}` ? 'Виконую…' : idle

  return (
    <>
      <div className="person__actions">
        <button
          type="button"
          className="button--danger"
          disabled={busy}
          onClick={() => {
            setConfirming('cancel')
          }}
        >
          {label('cancel_handover', 'Скасувати помилкову передачу')}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={busy}
          onClick={() => {
            setConfirming('record')
          }}
        >
          {label('record_owner_statement', 'Залишити зі слів власника')}
        </button>
      </div>

      <ConfirmDialog
        open={confirming === 'cancel'}
        title="Книжка зараз у вас?"
        description="Скасовувати передачу можна лише якщо книжка фізично в вас і передачу записано помилково. Позика скасується, примірник знову стане доступним. Якщо книжки в вас немає — не скасовуйте: залиште запис зі слів власника й далі зафіксуйте, що з нею сталося."
        confirmLabel="Так, книжка в мене — скасувати передачу"
        pending={busy}
        onConfirm={() => {
          setConfirming(undefined)
          void onAct(confirmation, { action: 'cancel_handover', bookIsWithOwner: true })
        }}
        onCancel={() => {
          setConfirming(undefined)
        }}
      />

      <ConfirmDialog
        open={confirming === 'record'}
        title="Залишити зі слів власника?"
        description="Передача лишиться активною як запис лише з ваших слів. Це НЕ підтвердження гостя, і ви не зможете потім видати нове посилання для цього запиту."
        confirmLabel="Залишити зі слів власника"
        pending={busy}
        onConfirm={() => {
          setConfirming(undefined)
          void onAct(confirmation, { action: 'record_owner_statement' })
        }}
        onCancel={() => {
          setConfirming(undefined)
        }}
      />
    </>
  )
}
