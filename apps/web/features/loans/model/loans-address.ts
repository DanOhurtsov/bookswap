import { LOAN_ROLES, type LoanRole } from '@bookswap/shared'
import { CURRENT_STATUS_FILTERS, HISTORY_STATUS_FILTERS, type ShownStatus } from './loan-status'

/**
 * BS-143, BS-153: what `/loans` shows is decided by its query string alone — the URL is the state, so
 * a direct link, a reload and a changed address all open the same screen. This module is the one
 * place that reads and writes those parameters.
 *
 * - `?loanId=` opens one loan and wins over everything else: links from notifications and cards
 *   carry it, and an old link must not open a tab instead of the loan it names.
 * - `?tab=history` opens the personal history — one list of both directions (BS-142). An old
 *   `?historyView=borrowed|lent` no longer filters anything and is never written, but like any
 *   other parameter it is left in the address.
 * - Otherwise the current loans, the side from `?role=`. The role is a UI hint, not a right: without
 *   it, or with an unknown value, both sides are shown («Усі»).
 * - `?q=` and `?status=` filter the open tab. A status the tab cannot show is no filter at all.
 * - A loan opened from a list keeps the list's parameters beside its `loanId` (`loanHref`), so the
 *   way back (`loansBackHref`) only drops the `loanId`.
 */

export const ALL_TAB = 'all'
export const HISTORY_TAB = 'history'

/** The current loans of one side, or of both. */
export type LoanSide = typeof ALL_TAB | LoanRole

/** The order of the tabs inside «Позичання», as the canvas draws them. */
export const LOANS_TABS = [ALL_TAB, 'borrower', 'owner', HISTORY_TAB] as const

export type LoansTab = (typeof LOANS_TABS)[number]

export const LOANS_HISTORY_HREF = `/loans?tab=${HISTORY_TAB}`

export type LoansFilters = {
  /** As typed: the list trims and folds it when matching. */
  query: string
  status: ShownStatus | null
}

export type LoansAddress =
  | { mode: 'loan'; loanId: string }
  | { mode: 'list'; side: LoanSide; filters: LoansFilters }
  | { mode: 'history'; filters: LoansFilters }

export type LoansListAddress = Exclude<LoansAddress, { mode: 'loan' }>

/** `URLSearchParams` and Next's `ReadonlyURLSearchParams` alike. */
export type QueryParameters = Pick<URLSearchParams, 'get' | 'toString'>

export function readLoansAddress(parameters: QueryParameters): LoansAddress {
  const loanId = parameters.get('loanId')

  if (loanId !== null) return { mode: 'loan', loanId }

  if (parameters.get('tab') === HISTORY_TAB) {
    return { mode: 'history', filters: readFilters(parameters, HISTORY_TAB) }
  }

  const role = LOAN_ROLES.find((value) => value === parameters.get('role'))
  const side = role ?? ALL_TAB

  return { mode: 'list', side, filters: readFilters(parameters, side) }
}

export function tabOf(address: LoansListAddress): LoansTab {
  return address.mode === 'history' ? HISTORY_TAB : address.side
}

/** The statuses a tab can be filtered by: the history has its own, every current tab the same. */
export function statusFiltersOf(tab: LoansTab): readonly ShownStatus[] {
  return tab === HISTORY_TAB ? HISTORY_STATUS_FILTERS : CURRENT_STATUS_FILTERS
}

function readFilters(parameters: QueryParameters, tab: LoansTab): LoansFilters {
  const status = statusFiltersOf(tab).find((value) => value === parameters.get('status'))

  return { query: parameters.get('q') ?? '', status: status ?? null }
}

/**
 * The address of a tab. Only the parameters the tab is made of change, and a status the new tab
 * cannot show: the search and anything else stay.
 */
export function loansTabHref(parameters: QueryParameters, tab: LoansTab): string {
  return hrefOf(withTab(parameters, tab))
}

function withTab(parameters: QueryParameters, tab: LoansTab): URLSearchParams {
  const next = new URLSearchParams(parameters.toString())

  if (tab === HISTORY_TAB) {
    next.set('tab', HISTORY_TAB)
  } else {
    next.delete('tab')
    if (tab === ALL_TAB) next.delete('role')
    else next.set('role', tab)
  }

  const status = next.get('status')

  if (status !== null && !statusFiltersOf(tab).some((value) => value === status)) {
    next.delete('status')
  }

  return next
}

/**
 * One loan, opened from the list of `tab`: the list's parameters stay beside `loanId`, which wins over
 * them (`readLoansAddress`). «Усі» is written out too (`tab=all`, read as «Усі» like no tab at all):
 * without it a loan opened from «Усі» would look like a direct link, which has no list to return to.
 */
export function loanHref(parameters: QueryParameters, tab: LoansTab, loanId: string): string {
  const next = withTab(parameters, tab)

  if (tab === ALL_TAB) next.set('tab', ALL_TAB)
  next.set('loanId', loanId)

  return hrefOf(next)
}

/**
 * «← Позичання» from one loan: the list it was opened from, with its search and status — the same
 * parameters without `loanId`. A direct link (a notification) names no list; `fallback` is the tab
 * where that loan is listed.
 *
 * `?role=` is a hint anyone can write into a link: it names the list only when it is the side the
 * server gave the viewer (`role`, `null` until the loan is known). A borrower is never sent to the
 * owner's list by a guessed or stale `role=owner`.
 */
export function loansBackHref(
  parameters: QueryParameters,
  role: LoanRole | null,
  fallback: LoansTab,
): string {
  const next = new URLSearchParams(parameters.toString())

  next.delete('loanId')

  const tab = next.get('tab')

  if (tab === HISTORY_TAB) return hrefOf(next)
  if (tab === ALL_TAB) return loansTabHref(next, ALL_TAB)
  if (role !== null && next.get('role') === role) return hrefOf(next)

  return loansTabHref(next, fallback)
}

/**
 * One loan for its borrower, from outside the list (a friend's shelf): `role=borrower` is the viewer's
 * side, so «← Позичання» there leads to «Я позичаю».
 */
export function borrowerLoanHref(loanId: string): string {
  return `/loans?loanId=${encodeURIComponent(loanId)}&role=borrower`
}

/** The address with other filters in the same tab; an empty search or `null` status is dropped. */
export function loansFiltersHref(
  parameters: QueryParameters,
  filters: Partial<LoansFilters>,
): string {
  const next = new URLSearchParams(parameters.toString())

  if (filters.query !== undefined) {
    if (filters.query.trim() === '') next.delete('q')
    else next.set('q', filters.query)
  }

  if (filters.status !== undefined) {
    if (filters.status === null) next.delete('status')
    else next.set('status', filters.status)
  }

  return hrefOf(next)
}

function hrefOf(parameters: URLSearchParams): string {
  const query = parameters.toString()

  return query === '' ? '/loans' : `/loans?${query}`
}
