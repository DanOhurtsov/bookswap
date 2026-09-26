'use client'

import { useState } from 'react'
import type { Loan, LoanAction } from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { LOAN_ACTION_LABELS, formatDate } from '@/app/lib/labels'

interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

interface RecordedLoanActionsProps {
  loan: Loan
  isOwner: boolean
  /** Якась дія на екрані виконується — кнопки чекають. */
  busy: boolean
  busyKey: string | undefined
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
  onConfirm: (confirmation: Confirmation) => void
}

const todayUtc = (): string => new Date().toISOString().slice(0, 10)

/**
 * Stage 10 (10e, D6): дії над записаною власником позикою, що чекає відповіді (`PENDING_CONFIRMATION`).
 *
 * Показує лише **пропозицію** дій за роллю: остаточне рішення (роль, стан, дати) ухвалює API. Правка дат
 * доступна лише поки позичальник не підтвердив (Q12) — після підтвердження статус інший, і цей компонент
 * не рендериться.
 */
export function RecordedLoanActions({
  loan,
  isOwner,
  busy,
  busyKey,
  onAct,
  onConfirm,
}: RecordedLoanActionsProps) {
  const label = (action: LoanAction): string =>
    busyKey === `${action}:${loan.id}` ? 'Виконую…' : LOAN_ACTION_LABELS[action]

  if (!isOwner) {
    return (
      <>
        <span className="book__meta">
          Власник записав, що передав вам цю книжку
          {loan.handedAt === null ? '' : ` ${formatDate(loan.handedAt)}`}
          {loan.dueAt === null ? '' : `, повернути до ${formatDate(loan.dueAt)}`}. Підтвердьте, якщо
          справді отримали, або відхиліть запис. До вашої відповіді книжка недоступна іншим.
        </span>
        <div className="person__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onAct(loan, 'confirm_record')
            }}
          >
            {label('confirm_record')}
          </button>
          <button
            type="button"
            className="button--danger"
            disabled={busy}
            onClick={() => {
              onConfirm({
                title: 'Відхилити запис?',
                description:
                  'Ви повідомите власнику, що книжки не отримували. Запис закриється, а книжка знову стане вільною.',
                confirmLabel: LOAN_ACTION_LABELS.decline_record,
                run: () => onAct(loan, 'decline_record'),
              })
            }}
          >
            {label('decline_record')}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <span className="book__meta">
        Чекаємо, поки {loan.borrower.displayName} підтвердить отримання. До відповіді книжка
        недоступна іншим. Поки відповіді немає, можна виправити дати або відкликати запис.
      </span>
      <AmendRecordForm loan={loan} busy={busy} label={label('amend_record')} onAct={onAct} />
      <div className="person__actions">
        <button
          type="button"
          className="button--danger"
          disabled={busy}
          onClick={() => {
            onConfirm({
              title: 'Відкликати запис?',
              description: 'Запис закриється, а книжка знову стане вільною. Друга буде сповіщено.',
              confirmLabel: LOAN_ACTION_LABELS.withdraw_record,
              run: () => onAct(loan, 'withdraw_record'),
            })
          }}
        >
          {label('withdraw_record')}
        </button>
      </div>
    </>
  )
}

function AmendRecordForm({
  loan,
  busy,
  label,
  onAct,
}: {
  loan: Loan
  busy: boolean
  label: string
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
}) {
  const currentHanded = loan.handedAt === null ? '' : loan.handedAt.slice(0, 10)
  const currentDue = loan.dueAt ?? ''
  const [handedAt, setHandedAt] = useState(currentHanded)
  const [dueAt, setDueAt] = useState(currentDue)
  const changed = handedAt !== currentHanded || dueAt !== currentDue
  const valid = handedAt !== '' && (dueAt === '' || dueAt >= handedAt)

  return (
    <div className="form">
      <TextField
        id={`amend-handed-${loan.id}`}
        label="Коли віддали"
        type="date"
        max={todayUtc()}
        value={handedAt}
        onChange={(event) => {
          setHandedAt(event.target.value)
        }}
      />
      <TextField
        id={`amend-due-${loan.id}`}
        label="Повернути до"
        type="date"
        min={handedAt === '' ? undefined : handedAt}
        hint={
          currentDue === ''
            ? 'Не вказано. Можна додати дату.'
            : 'Строк можна змінити або прибрати, очистивши поле.'
        }
        value={dueAt}
        onChange={(event) => {
          setDueAt(event.target.value)
        }}
      />
      <button
        type="button"
        className="button--ghost"
        disabled={busy || !changed || !valid}
        onClick={() => {
          void onAct(loan, 'amend_record', {
            ...(handedAt === currentHanded ? {} : { handedAt }),
            ...(dueAt === currentDue ? {} : { dueAt: dueAt === '' ? null : dueAt }),
          })
        }}
      >
        {label}
      </button>
    </div>
  )
}
