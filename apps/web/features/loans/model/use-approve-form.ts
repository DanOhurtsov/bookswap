'use client'

import { useState } from 'react'
import type { Loan, LoanTermDays } from '@bookswap/shared'
import { initialDueDate } from './approve-due-date'

/**
 * §8: an approval's two fields — the return date and the answer — and the body they make. One hook for
 * `/loans` and the home page (BS-147), so an approval sends the same thing from either.
 */
export function useApproveForm(
  loan: Pick<Loan, 'dueAt'>,
  defaultLoanTermDays: LoanTermDays | null,
) {
  const [dueAt, setDueAt] = useState(() =>
    initialDueDate(loan.dueAt, defaultLoanTermDays, new Date()),
  )
  const [note, setNote] = useState('')

  return { dueAt, setDueAt, note, setNote, body: approveBody(dueAt, note) }
}

export type ApproveFormState = ReturnType<typeof useApproveForm>

/** An empty field is not sent: no date means no term, a blank answer means none. */
export function approveBody(dueAt: string, note: string): Record<string, unknown> {
  return {
    ...(dueAt === '' ? {} : { dueAt }),
    ...(note.trim() === '' ? {} : { note }),
  }
}
