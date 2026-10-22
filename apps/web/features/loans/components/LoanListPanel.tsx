'use client'

import { useState } from 'react'
import { LOAN_STATUS, type LoanRole, type Me } from '@bookswap/shared'
import { SelectField, labelledOptions } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { LOAN_STATUS_LABELS } from '@/app/lib/labels'
import { useLoans } from '@/app/lib/use-loans'
import { useLoanActions } from '../model/use-loan-actions'
import { LoanCard } from './LoanCard'
import { LoanDialog } from './LoanCardActions'

/** `''` — no status filter. */
const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'будь-який' },
  ...labelledOptions(LOAN_STATUS, LOAN_STATUS_LABELS),
]

type LoanListPanelProps = {
  user: Me
  role: LoanRole
}

/**
 * One side of the current loans: «Мої книжки» or «Я позичаю». Mounted only while one of those tabs
 * is open, so the history tab never loads this list. Both sides render this same component, so the
 * status filter survives switching between them.
 */
export function LoanListPanel({ user, role }: LoanListPanelProps) {
  const [statusFilter, setStatusFilter] = useState('')
  const status = LOAN_STATUS.find((value) => value === statusFilter)
  const { state, reload } = useLoans({ role, status })
  const actions = useLoanActions(reload)

  return (
    <>
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault()
        }}
        noValidate
      >
        <SelectField
          id="filter-loan-status"
          label="Статус"
          value={statusFilter}
          options={STATUS_FILTER_OPTIONS}
          onValueChange={setStatusFilter}
        />
      </form>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.loans.length === 0 && (
        <p className="empty">
          {role === 'owner'
            ? 'Вашими книжками поки ніхто не цікавився. Якщо ви вже віддали книжку другові, запишіть це в бібліотеці.'
            : 'Ви поки нічого не позичали й не просили. Загляньте в бібліотеку друга.'}
        </p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.loans.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              userId={user.id}
              busyKey={actions.busyKey}
              onAct={actions.act}
              onConfirm={actions.setConfirmation}
            />
          ))}
        </ul>
      )}

      <LoanDialog actions={actions} />
    </>
  )
}
