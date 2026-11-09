'use client'

import type { Me } from '@bookswap/shared'
import { useLoans } from '@/app/lib/use-loans'
import { toCurrentLoansView } from '../model/current-loans-view'
import type { LoanSide, LoansFilters } from '../model/loans-address'
import { useLoansAddress } from '../model/use-loans-address'
import { LoanRowsSkeleton } from './LoanRows'
import { LoansListBody, LoansLoadError } from './LoansListStates'
import { LoansTabsLayout } from './LoansTabsLayout'

type CurrentLoansPanelProps = {
  user: Me
  side: LoanSide
  filters: LoansFilters
}

/**
 * «Усі», «Я позичаю», «У мене позичають»: one `GET /loans` of both sides (PO, 05.11.2026), split and
 * filtered here. The three tabs are this one component, so switching between them reads nothing
 * again; «Історія» is another, so while it is open this list is not read at all.
 */
export function CurrentLoansPanel({ user, side, filters }: CurrentLoansPanelProps) {
  const { state, reload } = useLoans({})
  const { setFilters, parameters } = useLoansAddress()
  const view =
    state.status === 'ready'
      ? toCurrentLoansView({ loans: state.data.loans, userId: user.id, side, filters, parameters })
      : undefined

  return (
    <LoansTabsLayout
      tab={side}
      filters={filters}
      counts={view?.counts}
      resultLabel={view?.resultLabel}
      isLoading={state.status === 'loading'}
    >
      {state.status === 'loading' && <LoanRowsSkeleton />}
      {state.status === 'error' && (
        <LoansLoadError
          message={state.message}
          onRetry={() => {
            void reload()
          }}
        />
      )}
      {view !== undefined && (
        <LoansListBody
          view={view}
          kind={side}
          onReset={() => {
            setFilters({ query: '', status: null })
          }}
        />
      )}
    </LoansTabsLayout>
  )
}
