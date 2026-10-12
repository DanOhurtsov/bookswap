'use client'

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useReloadOnResourceChange } from '@/app/lib/resource-sync'
import type { FieldErrors } from '@/app/lib/validation'
import { searchUsers } from '../api/user-search-requests'
import {
  USER_SEARCH_DELAY_MS,
  USER_SEARCH_STALE_MS,
  isBlankSearch,
  userSearchView,
  validateSearch,
  type UserSearchView,
} from './user-search'

/** One resource, one key (CONVENTIONS §3.9): every search, of every viewer. */
export const USER_SEARCH_QUERY_KEY = ['users', 'search'] as const

export const userSearchKeyOf = (viewerId: string) => [...USER_SEARCH_QUERY_KEY, viewerId] as const

export interface UserSearchOptions {
  /** The text to start from — the address the page was opened with. A valid one runs at once. */
  initialText?: string
  /** The executed search changed: a query was launched, or the field was emptied. */
  onSearchChange?: (query: string | undefined) => void
}

export interface UserSearch {
  text: string
  /** The normalized query the results belong to; `undefined` while none is due. */
  active: string | undefined
  errors: FieldErrors
  view: UserSearchView
  changeText: (text: string) => void
  /** «Знайти» or Enter: runs now, with the validation message the pause never shows. */
  submit: () => void
  /** Text from outside (the address, Back/Forward) runs at once, as a submit would. Stable. */
  runText: (text: string) => void
}

/**
 * Search among all users while typing — the logic the header panel and the search page share.
 * The text is searched `USER_SEARCH_DELAY_MS` after the last change; «Знайти» and Enter run it at
 * once and take the pause's place.
 *
 * The pending timer and the active search are only ever changed together, here — so whenever the
 * text is searchable and no search is active, a timer is pending. Each search is its own query
 * key, scoped to the viewer: a late answer or error for an earlier text lands under that text's
 * key and never replaces what the current one shows. Two mounted searches for the same text share
 * one cache entry and one request.
 */
export function useUserSearch(viewerId: string, options: UserSearchOptions = {}): UserSearch {
  const queryClient = useQueryClient()
  const [start] = useState(() => startOf(options.initialText ?? ''))
  const [text, setText] = useState(options.initialText ?? '')
  const [active, setActive] = useState(start.active)
  const [errors, setErrors] = useState<FieldErrors>(start.errors)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onSearchChange = useRef(options.onSearchChange)

  useEffect(() => {
    onSearchChange.current = options.onSearchChange
  })

  useEffect(() => () => clearTimeout(timer.current), [])

  const query = useQuery({
    queryKey: [...userSearchKeyOf(viewerId), active],
    queryFn: active === undefined ? skipToken : ({ signal }) => searchUsers(active, signal),
    // A fresh answer is shared, not re-asked: «Показати всі» opens the page from this cache.
    staleTime: USER_SEARCH_STALE_MS,
    // Searches run when the person types or acts — not on window focus or reconnect.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A failed search is shown at once, with its own retry.
    retry: false,
  })

  // A friendship changed anywhere (the friends page, a notification, an action in this or another
  // mounted search): the relations shown here are out of date. A refresh already in flight is not
  // restarted, so one action is one refetch however many searches listen.
  const refreshRelations = useCallback(
    () =>
      queryClient.invalidateQueries(
        { queryKey: userSearchKeyOf(viewerId) },
        { cancelRefetch: false },
      ),
    [queryClient, viewerId],
  )

  useReloadOnResourceChange('friends', refreshRelations)

  const launch = useCallback((next: string) => {
    setActive(next)
    setErrors({})
    onSearchChange.current?.(next)
  }, [])

  const clear = useCallback(() => {
    setActive(undefined)
    setErrors({})
    onSearchChange.current?.(undefined)
  }, [])

  const runText = useCallback(
    (next: string) => {
      clearTimeout(timer.current)
      setText(next)

      if (isBlankSearch(next)) {
        clear()
        return
      }

      const result = validateSearch(next)

      if (result.ok) {
        launch(result.query)
        return
      }

      setActive(undefined)
      setErrors(result.errors)
    },
    [clear, launch],
  )

  function changeText(nextText: string): void {
    clearTimeout(timer.current)
    setText(nextText)

    if (isBlankSearch(nextText)) {
      clear()
      return
    }

    const result = validateSearch(nextText)

    // Only whitespace changed: the results on screen are already for this text.
    if (result.ok && result.query === active) return

    setActive(undefined)

    if (result.ok) timer.current = setTimeout(() => launch(result.query), USER_SEARCH_DELAY_MS)
  }

  function submit(): void {
    if (isBlankSearch(text)) {
      clearTimeout(timer.current)
      return
    }

    const result = validateSearch(text)

    if (result.ok && result.query === active) {
      // The same search again: ask anew, unless that very request is still on its way.
      clearTimeout(timer.current)
      setErrors({})
      void query.refetch({ cancelRefetch: false })
      return
    }

    runText(text)
  }

  return {
    text,
    active,
    errors,
    view: userSearchView({
      active,
      pending: active === undefined && validateSearch(text).ok,
      query: { data: query.data, error: query.error, isFetching: query.isFetching },
    }),
    changeText,
    submit,
    runText,
  }
}

/** The state `runText(text)` would leave, without its side effects — for the first render. */
function startOf(text: string): { active: string | undefined; errors: FieldErrors } {
  if (isBlankSearch(text)) return { active: undefined, errors: {} }

  const result = validateSearch(text)

  return result.ok
    ? { active: result.query, errors: {} }
    : { active: undefined, errors: result.errors }
}
