'use client'

import Link from 'next/link'
import type { LoanRole, Me } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import { roleOf, useLoan } from '@/app/lib/use-loans'
import { loansTabHref } from '../model/loans-address'
import { useLoanActions } from '../model/use-loan-actions'
import { LoanCard } from './LoanCard'
import { LoanDialog } from './LoanCardActions'

type SingleLoanViewProps = {
  user: Me
  loanId: string
}

/** §8: `GET /loans/:id`. The API answers someone else's loan with 404 — the page shows the error. */
export function SingleLoanView({ user, loanId }: SingleLoanViewProps) {
  const { state, reload } = useLoan(loanId)
  const actions = useLoanActions(reload)

  /**
   * Where «Показати всі» leads.
   *
   * The role is taken **only from the loaded loan** — by the same `owner`/`borrower` the server
   * granted access by. `?role=` from the query string never gets here: links from notifications
   * carry only `loanId`, and a fallback `owner` would send a borrower to someone else's list.
   *
   * Until the loan arrives the role is unknown — and there is simply no link. Showing it with a
   * guessed role would offer a transition that half the time leads the wrong way.
   */
  const backRole: LoanRole | null =
    state.status === 'ready' ? roleOf(state.data.loan, user.id) : null

  return (
    <LibrarySectionPage>
      <p className="form__aside">
        {backRole === null ? (
          'Одне позичання.'
        ) : (
          <>
            Одне позичання.{' '}
            <Link href={loansTabHref(new URLSearchParams(), backRole)}>Показати всі</Link>
          </>
        )}
      </p>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && (
        <>
          <FormStatus error={new Error(state.message)} />
          <p className="empty">Можливо, це позичання вам не належить або його вже немає.</p>
        </>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          <LoanCard
            loan={state.data.loan}
            user={user}
            busyKey={actions.busyKey}
            onAct={actions.act}
            onConfirm={actions.setConfirmation}
          />
        </ul>
      )}

      <LoanDialog actions={actions} />
    </LibrarySectionPage>
  )
}
