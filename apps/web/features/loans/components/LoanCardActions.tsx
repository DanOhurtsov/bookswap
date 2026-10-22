'use client'

import { useState, type ReactNode } from 'react'
import type { Loan, LoanAction } from '@bookswap/shared'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LostLoanRecovery } from '@/components/LostLoanRecovery'
import { RecordedLoanActions } from '@/components/RecordedLoanActions'
import { TextField } from '@/components/Form/FormFields'
import { LOAN_ACTION_LABELS } from '@/app/lib/labels'
import type { Confirmation, LoanActionsState } from '../model/use-loan-actions'

type LoanActionsProps = {
  loan: Loan
  isOwner: boolean
  busyKey: string | undefined
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
  onConfirm: (confirmation: Confirmation) => void
}

/**
 * Buttons exactly per the §5.1 table.
 *
 * A `switch` without `default` on purpose: a new loan status must break the build here rather than
 * quietly leave the card without any action. The same technique as `RelationAction` on the friends
 * page. The server still decides "may I" — the buttons only don't offer what is certain to be a 409.
 */
export function LoanActions({ loan, isOwner, busyKey, onAct, onConfirm }: LoanActionsProps) {
  const busy = busyKey !== undefined
  const label = (action: LoanAction): string =>
    busyKey === `${action}:${loan.id}` ? 'Виконую…' : LOAN_ACTION_LABELS[action]

  const button = (action: LoanAction, danger = false): ReactNode => (
    <button
      key={action}
      type="button"
      className={danger ? 'button--danger' : 'button--ghost'}
      disabled={busy}
      onClick={() => {
        if (!danger) {
          void onAct(loan, action)
          return
        }

        onConfirm({
          title: `${LOAN_ACTION_LABELS[action]}?`,
          description: DANGER_DESCRIPTIONS[action],
          confirmLabel: LOAN_ACTION_LABELS[action],
          run: () => onAct(loan, action),
        })
      }}
    >
      {label(action)}
    </button>
  )

  switch (loan.status) {
    case 'REQUESTED':
      return (
        <div className="person__actions">
          {isOwner ? (
            <>
              <ApproveForm loan={loan} busy={busy} label={label('approve')} onAct={onAct} />
              {button('reject')}
            </>
          ) : (
            button('cancel')
          )}
        </div>
      )

    case 'APPROVED':
      return (
        <div className="person__actions">
          {/* §5.2: "received" is pressed by exactly the one who received it. */}
          {!isOwner && button('hand_over')}
          {button('cancel', true)}
        </div>
      )

    case 'HANDED_OVER':
      return (
        <div className="person__actions">
          {isOwner ? (
            <>
              {button('return')}
              {button('mark_lost', true)}
            </>
          ) : (
            <span className="book__meta">Чекаємо, поки власник підтвердить повернення.</span>
          )}
        </div>
      )

    // Stage 10 (10d): the status stays LOST; a find is a separate fact, not a status transition.
    case 'LOST':
      return (
        <LostLoanRecovery
          loan={loan}
          isOwner={isOwner}
          busy={busy}
          submitting={busyKey === `recover:${loan.id}`}
          onRecover={(body) => void onAct(loan, 'recover', body)}
        />
      )

    // Stage 10 (10e, D6): an owner's record awaiting an answer. Dates are editable only until it is
    // confirmed (Q12).
    case 'PENDING_CONFIRMATION':
      return (
        <RecordedLoanActions
          loan={loan}
          isOwner={isOwner}
          busy={busy}
          busyKey={busyKey}
          onAct={onAct}
          onConfirm={onConfirm}
        />
      )

    case 'DECLINED':
      return (
        <span className="book__meta">
          {isOwner
            ? `${loan.borrower.displayName} відхилив(-ла) запис. Книжка знову вільна: можна записати заново.`
            : 'Ви відхилили цей запис.'}
        </span>
      )

    // Terminal states of §5.1: no transition leads out of them — for anyone.
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
      return null
  }
}

const DANGER_DESCRIPTIONS: Readonly<Record<LoanAction, string>> = {
  approve: '',
  reject: '',
  cancel: 'Домовленість скасується, і книжка знову стане вільною. Другу сторону буде сповіщено.',
  hand_over: '',
  return: '',
  mark_lost:
    'Примірник позначиться як недоступний і залишиться за позичальником. Якщо книжка знайдеться, власник зможе це відмітити.',
  recover: '',
  confirm_record: '',
  decline_record: '',
  withdraw_record: '',
  amend_record: '',
}

type ApproveFormProps = {
  loan: Loan
  busy: boolean
  label: string
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
}

/**
 * §8: `dueAt` is accepted only together with `approve` — the owner sets the term while approving
 * the request. That is why the field lives inside this action and not on its own.
 */
function ApproveForm({ loan, busy, label, onAct }: ApproveFormProps) {
  const [dueAt, setDueAt] = useState(loan.dueAt ?? '')
  const [note, setNote] = useState('')

  return (
    <>
      <TextField
        id={`due-${loan.id}`}
        label="Повернути до"
        type="date"
        hint={loan.dueAt === null ? undefined : 'Позичальник просив саме цю дату.'}
        value={dueAt}
        onChange={(event) => {
          setDueAt(event.target.value)
        }}
      />
      <TextField
        id={`note-${loan.id}`}
        label="Відповідь"
        autoComplete="off"
        value={note}
        onChange={(event) => {
          setNote(event.target.value)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void onAct(loan, 'approve', {
            ...(dueAt === '' ? {} : { dueAt }),
            ...(note.trim() === '' ? {} : { note }),
          })
        }
      >
        {label}
      </button>
    </>
  )
}

/** The confirmation of a dangerous action, shared by the list and the one-loan view. */
export function LoanDialog({ actions }: { actions: LoanActionsState }) {
  const { confirmation, busyKey, setConfirmation } = actions

  return (
    <ConfirmDialog
      open={confirmation !== undefined}
      title={confirmation?.title ?? ''}
      description={confirmation?.description}
      confirmLabel={confirmation?.confirmLabel ?? 'Підтвердити'}
      pending={busyKey !== undefined}
      onConfirm={() => {
        void confirmation?.run()
      }}
      onCancel={() => {
        setConfirmation(undefined)
      }}
    />
  )
}
