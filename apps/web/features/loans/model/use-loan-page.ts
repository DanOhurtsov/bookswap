'use client'

import { useState } from 'react'
import { useLoan } from '@/app/lib/use-loans'
import { loadProblemOf, loanPageStateOf, type LoanPageMemory } from './loan-page-state'

/**
 * `useLoan` for one loan's page: what to show is `loanPageStateOf`; this hook only remembers the
 * last loan and the last problem of this `loanId`, and whether a retry is under way.
 */
export function useLoanPage(loanId: string) {
  const { state, reload } = useLoan(loanId)
  const [memory, setMemory] = useState<LoanPageMemory>()
  const [retrying, setRetrying] = useState(false)

  // The documented render-time adjustment, as in `use-resource.ts`: a new answer is remembered in
  // the same render, so no frame shows the skeleton in its place.
  const loan = state.status === 'ready' ? state.data.loan : undefined
  const problem = state.status === 'error' ? loadProblemOf(state.httpStatus) : undefined
  const known = memory?.loanId === loanId ? memory : undefined

  if (loan !== undefined && known?.loan !== loan) {
    setMemory({ loanId, loan, problem: undefined })
  } else if (problem !== undefined && known?.problem !== problem) {
    // Only a temporary failure keeps the loan on screen; after a 401, 403 or 404 it is forgotten.
    setMemory({ loanId, loan: problem === 'unavailable' ? known?.loan : undefined, problem })
  }

  /** Asks again after a failure; a second press while it runs does nothing. */
  const retry = () => {
    if (retrying) return

    setRetrying(true)
    void reload().finally(() => {
      setRetrying(false)
    })
  }

  return { page: loanPageStateOf(state, memory, loanId, retrying), reload, retry }
}
