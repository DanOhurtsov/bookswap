import type { LoanTermDays } from '@bookswap/shared'

/**
 * BS-148: the date an approval starts with. The borrower's own proposal wins — it is what they asked
 * for; otherwise the owner's default term counted from today; otherwise empty, i.e. no term.
 *
 * A local calendar date, not UTC: the field is `<input type="date">`, which speaks the owner's own day.
 */
export function initialDueDate(
  requested: string | null,
  termDays: LoanTermDays | null,
  today: Date,
): string {
  if (requested !== null) return requested
  if (termDays === null) return ''

  const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + termDays)
  const month = String(due.getMonth() + 1).padStart(2, '0')
  const day = String(due.getDate()).padStart(2, '0')

  return `${String(due.getFullYear())}-${month}-${day}`
}
