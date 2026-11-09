'use client'

import { useState } from 'react'
import type { Loan, LoanAction } from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'

export interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  /** The button that only closes the dialog: it says that nothing will happen. */
  dismissLabel?: string
  run: () => Promise<unknown>
  /** Where the focus returns when the dialog closes; by default, what had it when it opened. */
  opener?: HTMLElement | null
}

/**
 * The shared mechanics of acting on a loan.
 *
 * The one loan's page and the home page's requests do the same things to a loan and differ only in
 * where the data came from. Two sets of `busyKey`, `failure` and confirmation would one day drift.
 */
export function useLoanActions(
  reload: () => Promise<void>,
  /** Optional: what to do about a failure besides showing it — the home page re-reads on a conflict. */
  onFailure?: (failure: Error) => Promise<void> | undefined,
) {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()

  /** Whether the action went through: only then the caller may say so (BS-153: the toast). */
  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      // `await` on purpose: without it `busyKey` would clear before the new data arrives, and the
      // same action could be pressed a second time on an already stale card.
      await reload()
      setConfirmation(undefined)
      return true
    } catch (error) {
      const shown = error instanceof ApiRequestError ? error : new Error(describeError(error))
      setFailure(shown)
      // Awaited for the same reason as `reload`: the card stays busy while the caller reacts.
      await onFailure?.(shown)
      // BS-153: a confirmation that failed stays open, so it can be tried again as it is.
      return false
    } finally {
      setBusyKey(undefined)
    }
  }

  const act = (loan: Loan, action: LoanAction, body: Record<string, unknown> = {}) =>
    run(`${action}:${loan.id}`, async () => {
      await apiRequest(`/loans/${loan.id}`, { method: 'PATCH', body: { action, ...body } })
    })

  /** Asks before a dangerous action. A failure shown before is about another attempt: it goes. */
  const confirm = (next: Confirmation) => {
    setFailure(undefined)
    setConfirmation(next)
  }

  return { failure, busyKey, confirmation, confirm, setConfirmation, act }
}
