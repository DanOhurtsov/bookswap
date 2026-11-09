'use client'

import { useMyHistory } from '@/app/lib/use-history'
import { toHistoryLoansView } from '../model/history-loans-view'
import { HISTORY_TAB, type LoansFilters } from '../model/loans-address'
import { useLoansAddress } from '../model/use-loans-address'
import { LoanRowsSkeleton } from './LoanRows'
import { LoansListBody, LoansLoadError } from './LoansListStates'
import { LoansTabsLayout } from './LoansTabsLayout'

/**
 * §6.6, personal history: one list of what I borrowed and what I lent (BS-142). Mounted only on the
 * «Історія» tab, and it reads `GET /me/history` — never the current loans list.
 */
export function LoansHistoryPanel({ filters }: { filters: LoansFilters }) {
  const { state, reload } = useMyHistory()
  const { setFilters, parameters } = useLoansAddress()
  const view =
    state.status === 'ready' ? toHistoryLoansView(state.data, filters, parameters) : undefined

  return (
    <LoansTabsLayout
      tab={HISTORY_TAB}
      filters={filters}
      counts={undefined}
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
          kind={HISTORY_TAB}
          onReset={() => {
            setFilters({ query: '', status: null })
          }}
        />
      )}
    </LoansTabsLayout>
  )
}
