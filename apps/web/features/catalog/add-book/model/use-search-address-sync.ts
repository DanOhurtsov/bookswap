'use client'

import type { SearchPageSize } from '@bookswap/shared'
import { useCallback, useRef, useState } from 'react'
import { searchHref } from '@/app/lib/search-page'
import { LEGACY_AUTO_PARAM } from './auto-search'
import { ADD_BOOK_PATH, clearedHref } from './search-address-urls'

/** The slice of the Next router this hook drives; a plain object in tests. */
export interface AddressRouter {
  push: (href: string) => void
  replace: (href: string, options: { scroll: boolean }) => void
}

export interface SearchAddressSyncInput {
  router: AddressRouter
  parameters: URLSearchParams
  pageSize: SearchPageSize
  /** `q` of the address as it is now. Only the first render's value seeds what is "ours". */
  q: string
}

export interface SearchAddressSync {
  /** The search in the address was written by typing (`search`), not by an explicit act or from outside. */
  typed: boolean
  /** Typing paused on `text`: `replace` with its full search, first page, no scrolling. */
  search: (text: string) => void
  /** The field went below a search: `replace` to the address without a query — only for a typed search. */
  clear: () => void
  /** A valid ISBN-13 was typed: `replace` with its full search, no waiting. */
  exact: (isbn13: string) => void
  /** An explicit full search: `push`, so Back returns to what was shown before. */
  pushFull: (text: string) => void
  /** The scanner found an ISBN: `push` the full search, but do NOT claim the address — the field follows it. */
  showScanned: (isbn: string) => void
  /**
   * For the effect that copies the address into the field. `true` when the address holds a query we
   * did not write (Back/Forward, the scanner, a link); it is then claimed, so the next call is `false`.
   */
  adoptExternal: (q: string) => boolean
}

/**
 * Owns "which query did WE write": every write that comes from the field marks its query and
 * navigates in one call, so a caller cannot do one without the other. An address whose query is not
 * ours is Back/Forward or the scanner, and the field follows it (`adoptExternal`). The scanner
 * deliberately does not mark (`showScanned`), and neither do pagination links, which keep `q`.
 *
 * Whether the search was typed decides two things the person sees: emptying the field drops a typed
 * search (an explicit one stays), and a typed search keeps the previous list while the next loads.
 */
export function useSearchAddressSync(input: SearchAddressSyncInput): SearchAddressSync {
  const { router, parameters, pageSize, q } = input
  const own = useRef(q)
  const [typed, setTyped] = useState(false)

  const fullHref = (text: string) =>
    searchHref(ADD_BOOK_PATH, parameters, { q: text, page: 1, pageSize }, [LEGACY_AUTO_PARAM])

  const adoptExternal = useCallback((nextQ: string) => {
    if (nextQ === own.current) return false

    own.current = nextQ
    setTyped(false)

    return true
  }, [])

  return {
    typed,
    search: (text) => {
      // This text is already the search we wrote (an explicit one started before the pause ended).
      if (own.current === text) return

      own.current = text
      setTyped(true)
      router.replace(fullHref(text), { scroll: false })
    },
    clear: () => {
      if (!typed) return

      own.current = ''
      setTyped(false)
      router.replace(clearedHref(parameters), { scroll: false })
    },
    exact: (isbn13) => {
      own.current = isbn13
      setTyped(false)
      router.replace(fullHref(isbn13), { scroll: false })
    },
    pushFull: (text) => {
      own.current = text
      setTyped(false)
      router.push(fullHref(text))
    },
    showScanned: (isbn) => {
      router.push(fullHref(isbn))
    },
    adoptExternal,
  }
}
