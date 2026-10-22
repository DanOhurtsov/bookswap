import { LOAN_ROLES, type LoanRole } from '@bookswap/shared'

/**
 * BS-143: what `/loans` shows is decided by its query string alone — the URL is the state, so a
 * direct link, a reload and a changed address all open the same screen. This module is the one
 * place that reads and writes those parameters.
 *
 * - `?loanId=` opens one loan and wins over everything else: links from notifications and cards
 *   carry it, and an old link must not open a tab instead of the loan it names.
 * - `?tab=history` opens the personal history — one list of both directions (BS-142). An old
 *   `?historyView=borrowed|lent` no longer filters anything and is never written, but like any
 *   other parameter it is left in the address.
 * - Otherwise the list tab comes from `?role=`. The role is a UI hint, not a right: an unknown
 *   value quietly becomes `owner`.
 */

export const HISTORY_TAB = 'history'

/** The order of the tabs inside «Позичання». */
export const LOANS_TABS = [...LOAN_ROLES, HISTORY_TAB] as const

export type LoansTab = (typeof LOANS_TABS)[number]

export const LOANS_HISTORY_HREF = `/loans?tab=${HISTORY_TAB}`

export type LoansAddress =
  { mode: 'loan'; loanId: string } | { mode: 'list'; role: LoanRole } | { mode: 'history' }

/** `URLSearchParams` and Next's `ReadonlyURLSearchParams` alike. */
type QueryParameters = Pick<URLSearchParams, 'get' | 'toString'>

export function readLoansAddress(parameters: QueryParameters): LoansAddress {
  const loanId = parameters.get('loanId')

  if (loanId !== null) return { mode: 'loan', loanId }

  if (parameters.get('tab') === HISTORY_TAB) return { mode: 'history' }

  const role = LOAN_ROLES.find((value) => value === parameters.get('role'))

  return { mode: 'list', role: role ?? 'owner' }
}

export function tabOf(address: Exclude<LoansAddress, { mode: 'loan' }>): LoansTab {
  return address.mode === 'history' ? HISTORY_TAB : address.role
}

/**
 * The address of a tab. Only the parameters the tab is made of change: `?status=` or anything else
 * that appears later must not vanish when the tab does.
 */
export function loansTabHref(parameters: QueryParameters, tab: LoansTab): string {
  const next = new URLSearchParams(parameters.toString())

  if (tab === HISTORY_TAB) {
    next.set('tab', HISTORY_TAB)
  } else {
    next.delete('tab')
    next.set('role', tab)
  }

  return `/loans?${next.toString()}`
}
