'use client'

import { useState } from 'react'
import type { Loan, LoanAction } from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'

export interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

/**
 * The shared mechanics of acting on a loan.
 *
 * Both views — the list and one loan — do the same things to a card and differ only in where the
 * data came from. Two sets of `busyKey`, `failure` and `ConfirmDialog` would one day drift apart.
 */
export function useLoanActions(reload: () => Promise<void>) {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      // `await` on purpose: without it `busyKey` would clear before the new data arrives, and the
      // same action could be pressed a second time on an already stale card.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
      setConfirmation(undefined)
    }
  }

  const act = (loan: Loan, action: LoanAction, body: Record<string, unknown> = {}): Promise<void> =>
    run(`${action}:${loan.id}`, async () => {
      await apiRequest(`/loans/${loan.id}`, { method: 'PATCH', body: { action, ...body } })
    })

  return { failure, busyKey, confirmation, setConfirmation, act }
}

export type LoanActionsState = ReturnType<typeof useLoanActions>
