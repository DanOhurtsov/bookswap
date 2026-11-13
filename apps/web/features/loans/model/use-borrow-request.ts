'use client'

import { useRef, useState } from 'react'
import { loanResponseSchema, type CreateLoanRequest } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { NO_DAY, type Day } from './loan-term'
import {
  isClosedPhase,
  phaseOfFailure,
  type BorrowPhase,
  type ClosedBorrowPhase,
} from './borrow-request'

/**
 * One request for one copy (§8, `POST /loans`) and where it stands. The typed values belong to the form
 * and outlive a failure. A press while a request is on its way is ignored here, not only by the button:
 * a second POST would make a second request. Once the request is settled — sent, or refused by a 409 —
 * the shelf is read again (`onSettled`, told how it was settled), so its «Попросити» and its links
 * follow the server.
 */
export function useBorrowRequest(
  copyId: string,
  onSettled: (outcome: ClosedBorrowPhase) => Promise<void> | void,
) {
  const [message, setMessage] = useState('')
  const [proposedDueAt, setProposedDueAt] = useState<Day>(NO_DAY)
  const [phase, setPhase] = useState<BorrowPhase>({ kind: 'draft' })
  const isSending = useRef(false)

  const send = async (): Promise<void> => {
    if (isSending.current) return

    // The fields cannot break the contract: the note is capped at its limit, the date comes from the
    // calendar. An empty one is not sent — no message, no proposed date.
    const body: CreateLoanRequest = {
      copyId,
      ...(message.trim() === '' ? {} : { message: message.trim() }),
      ...(proposedDueAt === NO_DAY ? {} : { proposedDueAt }),
    }

    isSending.current = true
    setPhase({ kind: 'sending' })

    let next: BorrowPhase

    try {
      const { loan } = await apiRequest('/loans', {
        method: 'POST',
        body,
        schema: loanResponseSchema,
      })
      next = { kind: 'sent', loanId: loan.id }
    } catch (error) {
      next = phaseOfFailure(error)
    } finally {
      isSending.current = false
    }

    setPhase(next)
    if (isClosedPhase(next)) await onSettled(next)
  }

  return { message, setMessage, proposedDueAt, setProposedDueAt, phase, send }
}

export type BorrowRequest = ReturnType<typeof useBorrowRequest>
