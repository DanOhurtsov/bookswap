'use client'

import type { Loan, LoanAction } from '@bookswap/shared'
import { useToastManager } from '@/components/ui/toast'
import { ACTION_DONE_MESSAGES } from './loan-action-plan'
import { useLoanActions } from './use-loan-actions'

/**
 * The actions of one loan's page: `useLoanActions` plus the toast the canvas shows once an action
 * went through. The toast is owned here, not by each button: it follows the server's answer and
 * never a press — a failure stays in the panel (and in an open dialog) instead.
 */
export function useLoanPageActions(reload: () => Promise<void>) {
  const actions = useLoanActions(reload)
  const toasts = useToastManager()

  const act = async (
    loan: Loan,
    action: LoanAction,
    body?: Record<string, unknown>,
  ): Promise<void> => {
    if (await actions.act(loan, action, body)) {
      toasts.add({ title: ACTION_DONE_MESSAGES[action] })
    }
  }

  return { ...actions, act }
}

export type LoanPageActions = ReturnType<typeof useLoanPageActions>
