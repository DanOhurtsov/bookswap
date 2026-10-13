'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useUserSearch, type UserSearch } from './use-user-search'
import { USER_SEARCH_QUERY_PARAM, userSearchPageHref } from './user-search'

/**
 * The search page: the same search, with its query kept in the address.
 *
 * A launched search is written with `replace` — typing never adds history entries; emptying the
 * field drops `query`. `own` remembers which address WE wrote: any other value is a direct open,
 * a link or Back/Forward, and the field follows it at once. Writing the address and marking it
 * ours happen in one place, so neither can be done without the other.
 */
export function useUserSearchAddress(viewerId: string): UserSearch {
  const router = useRouter()
  const parameters = useSearchParams()
  const addressQuery = parameters.get(USER_SEARCH_QUERY_PARAM) ?? ''
  const own = useRef(addressQuery)
  const search = useUserSearch(viewerId, {
    initialText: addressQuery,
    onSearchChange: (query) => {
      const next = query ?? ''

      if (next === own.current) return

      own.current = next
      router.replace(userSearchPageHref(query), { scroll: false })
    },
  })
  const { runText } = search

  useEffect(() => {
    if (addressQuery === own.current) return

    own.current = addressQuery
    runText(addressQuery)
  }, [addressQuery, runText])

  return search
}
