'use client'

import { useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import {
  loansFiltersHref,
  loansTabHref,
  readLoansAddress,
  type LoansAddress,
  type LoansFilters,
  type LoansTab,
  type QueryParameters,
} from './loans-address'

export interface LoansAddressState {
  address: LoansAddress
  /** The address's parameters as rendered: what a link from this screen keeps (`loanHref`). */
  parameters: QueryParameters
  /** Opens a tab: the search stays, a status the tab cannot show goes. */
  selectTab: (tab: LoansTab) => void
  /** Changes the search or the status in the open tab. */
  setFilters: (filters: Partial<LoansFilters>) => void
}

/**
 * The tab, the search and the status live in the address, not in `useState` (CONVENTIONS §3.8):
 * a reload, a shared link and a changed query open the same screen.
 *
 * Written through the History API, as `useLibraryAddress` does: Next folds those calls into its
 * router and updates `useSearchParams`, while a router navigation would ask the server for the
 * page again on every keystroke of the search.
 *
 * Always `replace`: no history entry. A tab or a filter is not a navigation step, and littering the
 * history with them would make a person press "back" many times to leave.
 *
 * A write starts from the address as it is now (`window.location`), not from the last render: a
 * second keystroke may come before the first one's address has rendered.
 */
export function useLoansAddress(): LoansAddressState {
  const parameters = useSearchParams()
  const address = useMemo(() => readLoansAddress(parameters), [parameters])

  return {
    address,
    parameters,
    selectTab: (tab) => {
      replaceAddress(loansTabHref(currentParameters(), tab))
    },
    setFilters: (filters) => {
      replaceAddress(loansFiltersHref(currentParameters(), filters))
    },
  }
}

function currentParameters(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

function replaceAddress(href: string): void {
  if (href === `${window.location.pathname}${window.location.search}`) return

  window.history.replaceState(null, '', href)
}
