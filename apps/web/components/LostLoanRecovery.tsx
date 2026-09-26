'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { Loan } from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { LOAN_ACTION_LABELS, formatDate } from '@/app/lib/labels'

interface LostLoanRecoveryProps {
  loan: Loan
  isOwner: boolean
  /** Якась дія на екрані виконується — кнопки чекають. */
  busy: boolean
  /** Саме `recover` цієї позики виконується. */
  submitting: boolean
  onRecover: (body: { effectiveAt?: string }) => void
}

/**
 * Stage 10 (10d): «Знайшлася» для втраченої позики.
 *
 * Показує лише **пропозицію** дії: чи можна насправді, вирішує API (роль, стан примірника, архів,
 * однократність) — відмова прийде помилкою. `Loan.status` лишається `LOST` завжди: знахідка — окремий
 * факт, а не новий статус, тож підпис позики цим компонентом не змінюється.
 */
export function LostLoanRecovery({
  loan,
  isOwner,
  busy,
  submitting,
  onRecover,
}: LostLoanRecoveryProps) {
  const [effectiveAt, setEffectiveAt] = useState('')

  if (loan.recovery !== null) {
    return (
      <span className="book__meta">
        Знайшлася {formatDate(loan.recovery.effectiveAt)}. Позика лишається позначеною як втрачена.
      </span>
    )
  }

  if (!isOwner) return null

  if (loan.copy.isArchived) {
    return (
      <span className="book__meta">
        Примірник в архіві: спершу відновіть його з архіву в <Link href="/library">бібліотеці</Link>
        , потім позначте, що книжка знайшлася.
      </span>
    )
  }

  if (loan.copy.status !== 'UNAVAILABLE') return null

  return (
    <div className="person__actions">
      <TextField
        id={`recover-${loan.id}`}
        label="Дата знахідки"
        type="date"
        max={new Date().toISOString().slice(0, 10)}
        hint="Необов’язково: без дати запишеться сьогодні. Не в майбутньому."
        value={effectiveAt}
        onChange={(event) => {
          setEffectiveAt(event.target.value)
        }}
      />
      <button
        type="button"
        className="button--ghost"
        disabled={busy}
        onClick={() => {
          onRecover(effectiveAt === '' ? {} : { effectiveAt })
        }}
      >
        {submitting ? 'Виконую…' : LOAN_ACTION_LABELS.recover}
      </button>
    </div>
  )
}
