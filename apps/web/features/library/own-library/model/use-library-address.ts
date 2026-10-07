'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo } from 'react'
import type { LibraryQueryRequest } from '@bookswap/shared'
import type { LibraryView } from '@/app/lib/use-library'
import { libraryHref, readLibraryAddress, type LibraryAddress } from './library-address'

export interface LibraryAddressState {
  view: LibraryView
  /** The applied filters; always empty outside the own view. */
  filters: LibraryQueryRequest
  /** Opens a view. It replaces the history entry and drops the filters: they belong to the own view. */
  selectView: (view: LibraryView) => void
  /** Applies filters in the own view. It adds a history entry, so "back" returns to the previous list. */
  applyFilters: (filters: LibraryQueryRequest) => void
}

/**
 * The open view and the applied filters live in the address, so a refresh, a shared link and "back"
 * all land where the user was.
 *
 * The address is written through the History API, not `router.push`: Next folds those calls into its
 * router and updates `useSearchParams`, while a router navigation would ask the server to render
 * the library page again, with its activation lookup, on every tab.
 */
export function useLibraryAddress(): LibraryAddressState {
  const parameters = useSearchParams()
  const address = useMemo(() => readLibraryAddress(parameters), [parameters])

  // An address that cannot be read is shown as the default view, so the address is corrected to say
  // the same, with `replace`: "back" must not return to the broken one.
  useEffect(() => {
    if (!address.valid) writeAddress({ view: address.view, filters: address.filters }, 'replace')
  }, [address])

  return {
    view: address.view,
    filters: address.filters,
    selectView: (view) => {
      writeAddress({ view, filters: {} }, 'replace')
    },
    applyFilters: (filters) => {
      writeAddress({ view: 'own', filters }, 'push')
    },
  }
}

function writeAddress(address: LibraryAddress, mode: 'push' | 'replace'): void {
  const href = libraryHref(address)

  if (href === `${window.location.pathname}${window.location.search}`) return

  if (mode === 'push') window.history.pushState(null, '', href)
  else window.history.replaceState(null, '', href)
}
