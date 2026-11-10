import type { LoanTermDays } from '@bookswap/shared'
import { addDays, localDay } from './loan-term'

/**
 * BS-148: the date an approval starts with. The borrower's own proposal wins — it is what they asked
 * for; otherwise the owner's default term counted from today; otherwise empty, i.e. no term.
 *
 * A local calendar date, not UTC: the owner picks a day of their own calendar.
 */
export function initialDueDate(
  requested: string | null,
  termDays: LoanTermDays | null,
  today: Date,
): string {
  if (requested !== null) return requested
  if (termDays === null) return ''

  return addDays(localDay(today), termDays)
}
