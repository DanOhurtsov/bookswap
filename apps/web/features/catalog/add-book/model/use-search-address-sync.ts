'use client'

import type { SearchPageSize } from '@bookswap/shared'
import { useCallback, useRef } from 'react'
import { searchHref } from '@/app/lib/search-page'
import { AUTO_PARAM } from './auto-search'
import { ADD_BOOK_PATH, addressKey, autoHref, clearedHref } from './search-address-urls'

/** The slice of the Next router this hook drives; a plain object in tests. */
export interface AddressRouter {
  push: (href: string) => void
  replace: (href: string, options: { scroll: boolean }) => void
}

export interface SearchAddressSyncInput {
  router: AddressRouter
  parameters: URLSearchParams
  pageSize: SearchPageSize
  /** The address as it is now: mode and query. Only the first render's value seeds the key. */
  autoMode: boolean
  q: string
}

export interface SearchAddressSync {
  /** Show suggestions for `text`: `replace` with `auto=1`. Skipped when we already started a full search of it. */
  suggest: (text: string) => void
  /** The field was emptied: `replace` to the address without a query. */
  clear: () => void
  /** A valid ISBN-13 was typed: `replace` with the full search, no waiting. */
  exact: (isbn13: string) => void
  /** An explicit full search: `push`, so Back returns to what was shown before. */
  pushFull: (text: string) => void
  /** The scanner found an ISBN: `push` the full search, but do NOT claim the address — the field follows it. */
  showScanned: (isbn: string) => void
  /**
   * For the effect that copies the address into the field. `true` when the address is not what we
   * last wrote (Back/Forward, the scanner); it is then claimed, so the next call is `false`.
   */
  adoptExternal: (autoMode: boolean, q: string) => boolean
}

/**
 * Owns "which address did WE write": every write that comes from the field marks its key and
 * navigates in one call, so a caller cannot do one without the other. An address change that is
 * not ours is Back/Forward or the scanner, and the field follows it (`adoptExternal`). The scanner
 * deliberately does not mark (`showScanned`), and neither do pagination links, which keep `q` and
 * the mode — and with them the key.
 */
export function useSearchAddressSync(input: SearchAddressSyncInput): SearchAddressSync {
  const { router, parameters, pageSize, autoMode, q } = input
  const own = useRef(addressKey(autoMode, q))

  const fullHref = (text: string) =>
    searchHref(ADD_BOOK_PATH, parameters, { q: text, page: 1, pageSize }, [AUTO_PARAM])

  const adoptExternal = useCallback((nextAutoMode: boolean, nextQ: string) => {
    const key = addressKey(nextAutoMode, nextQ)

    if (key === own.current) return false

    own.current = key

    return true
  }, [])

  return {
    suggest: (text) => {
      // A full search of this text is already started by us (a click on a suggestion), and the address has not changed yet.
      if (own.current === addressKey(false, text)) return

      own.current = addressKey(true, text)
      router.replace(autoHref(parameters, text, pageSize), { scroll: false })
    },
    clear: () => {
      own.current = addressKey(false, '')
      router.replace(clearedHref(parameters), { scroll: false })
    },
    exact: (isbn13) => {
      own.current = addressKey(false, isbn13)
      router.replace(fullHref(isbn13), { scroll: false })
    },
    pushFull: (text) => {
      own.current = addressKey(false, text)
      router.push(fullHref(text))
    },
    showScanned: (isbn) => {
      router.push(fullHref(isbn))
    },
    adoptExternal,
  }
}
