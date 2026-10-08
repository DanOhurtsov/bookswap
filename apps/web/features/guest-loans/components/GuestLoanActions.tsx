'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { GuestLoan, GuestLoanAction } from '@bookswap/shared'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TextField } from '@/components/Form/FormFields'
import { GUEST_LOAN_ACTION_LABELS, formatDate } from '@/app/lib/labels'

interface GuestLoanActionsProps {
  loan: GuestLoan
  /** Якась дія на екрані виконується — кнопки чекають. */
  busy: boolean
  busyKey: string | undefined
  onAct: (loan: GuestLoan, action: GuestLoanAction, body?: Record<string, unknown>) => Promise<void>
}

/**
 * Stage 10 (10f.3): дії над гостьовою позикою — `return`/`mark_lost`/`recover`/`close_loss`.
 *
 * §6.11.1 execution plan: «Знайшлася» (`recover`) і «Закрити втрату» (`close_loss`) — РІЗНІ факти.
 * `Loan.status` лишається `LOST` після обох. `recover` дозволений і ПІСЛЯ `close_loss` (Q3c) — тому
 * кнопка «Знайшлася» не зникає, щойно з'явилася `lossClosure`. Але `close_loss` після вже записаної
 * `RECOVERED` дає `409` (§0.7.1) — тому кнопка «Закрити втрату» зникає, щойно з'явилася `recovery`:
 * пропозиція дії, що гарантовано провалиться, гірша за її відсутність (той самий принцип, що вже
 * в `LoanActions`/`LostLoanRecovery` для реєстрованого флоу).
 */
export function GuestLoanActions({ loan, busy, busyKey, onAct }: GuestLoanActionsProps) {
  const [confirmingLost, setConfirmingLost] = useState(false)
  const [confirmingCloseLoss, setConfirmingCloseLoss] = useState(false)
  const [effectiveAt, setEffectiveAt] = useState('')

  const label = (action: GuestLoanAction): string =>
    busyKey === `${action}:${loan.id}` ? 'Виконую…' : GUEST_LOAN_ACTION_LABELS[action]

  if (loan.status === 'HANDED_OVER') {
    return (
      <>
        <div className="person__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onAct(loan, 'return')
            }}
          >
            {label('return')}
          </button>
          <button
            type="button"
            className="button--danger"
            disabled={busy}
            onClick={() => {
              setConfirmingLost(true)
            }}
          >
            {label('mark_lost')}
          </button>
        </div>
        <ConfirmDialog
          open={confirmingLost}
          title="Позначити втраченою?"
          description="Примірник позначиться як недоступний і залишиться за контактом. Якщо книжка знайдеться, можна буде відмітити «Знайшлася» або окремо закрити питання дією «Закрити втрату»."
          confirmLabel={GUEST_LOAN_ACTION_LABELS.mark_lost}
          pending={busy}
          onConfirm={() => {
            setConfirmingLost(false)
            void onAct(loan, 'mark_lost')
          }}
          onCancel={() => {
            setConfirmingLost(false)
          }}
        />
      </>
    )
  }

  if (loan.status !== 'LOST') return null // RETURNED — термінальний, як і в реєстрованому флоу.

  const canRecover = loan.recovery === null
  const canCloseLoss = loan.recovery === null && loan.lossClosure === null
  const showRecoverButton = canRecover && !loan.copy.isArchived

  return (
    <>
      {loan.recovery !== null && (
        <span className="book__meta">
          Знайшлася {formatDate(loan.recovery.effectiveAt)}. Позика лишається позначеною як
          втрачена.
        </span>
      )}

      {loan.lossClosure !== null && (
        <span className="book__meta">
          Втрату закрито {formatDate(loan.lossClosure.recordedAt)}
          {loan.recovery === null &&
            ' — книжку при цьому НЕ позначено знайденою; дія «Знайшлася» лишається доступною, якщо книжка з’явиться'}
          .
        </span>
      )}

      {canRecover && loan.copy.isArchived && (
        <span className="book__meta">
          Примірник в архіві: спершу відновіть його з архіву в{' '}
          <Link href="/library">бібліотеці</Link>, потім позначте, що книжка знайшлася.
        </span>
      )}

      {(showRecoverButton || canCloseLoss) && (
        <div className="person__actions">
          {showRecoverButton && (
            <>
              <TextField
                id={`guest-recover-${loan.id}`}
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
                  void onAct(loan, 'recover', effectiveAt === '' ? {} : { effectiveAt })
                }}
              >
                {label('recover')}
              </button>
            </>
          )}

          {canCloseLoss && (
            <button
              type="button"
              className="button--ghost"
              disabled={busy}
              onClick={() => {
                setConfirmingCloseLoss(true)
              }}
            >
              {label('close_loss')}
            </button>
          )}
        </div>
      )}

      {canCloseLoss && (
        <ConfirmDialog
          open={confirmingCloseLoss}
          title="Закрити втрату?"
          description="Це НЕ означає, що книжка знайшлася, і не змінює стан примірника — лише фіксує, що ви закриваєте питання цієї втрати. Дія «Знайшлася» лишиться доступною, якщо книжка з’явиться."
          confirmLabel={GUEST_LOAN_ACTION_LABELS.close_loss}
          pending={busy}
          onConfirm={() => {
            setConfirmingCloseLoss(false)
            void onAct(loan, 'close_loss')
          }}
          onCancel={() => {
            setConfirmingCloseLoss(false)
          }}
        />
      )}
    </>
  )
}
