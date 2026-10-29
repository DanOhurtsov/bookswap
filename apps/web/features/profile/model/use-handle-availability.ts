'use client'

import { skipToken, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { checkHandleAvailability } from '../api/profile-requests'
import {
  HANDLE_CHECK_DELAY_MS,
  handleCheckView,
  handleToAsk,
  type HandleCheckView,
} from './handle-check'

/** Whose check it is matters: the viewer's own current nickname is free only to them. */
export const handleAvailabilityKeyOf = (viewerId: string, handle: string | undefined) =>
  ['users', 'handles', 'availability', viewerId, handle] as const

/** An answer stays good for a while: typing a nickname back does not ask again. */
const HANDLE_CHECK_STALE_MS = 30_000

/**
 * BS-148: whether the nickname in the field may be taken, asked `HANDLE_CHECK_DELAY_MS` after the
 * last keystroke. Each nickname is its own query key, so an answer that comes late lands under its
 * own text and never stands for the one in the field now (`handleCheckView`).
 */
export function useHandleAvailability(
  viewerId: string,
  current: string,
  draft: string,
): HandleCheckView & { retry: () => void } {
  const toAsk = handleToAsk(current, draft)
  const [asked, setAsked] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (toAsk === undefined) return

    const timer = setTimeout(() => {
      setAsked(toAsk)
    }, HANDLE_CHECK_DELAY_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [toAsk])

  const query = useQuery({
    queryKey: handleAvailabilityKeyOf(viewerId, asked),
    queryFn:
      asked === undefined ? skipToken : ({ signal }) => checkHandleAvailability(asked, signal),
    staleTime: HANDLE_CHECK_STALE_MS,
    // A check runs because the person typed — not on focus or reconnect; a failure has its own retry.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })

  return {
    ...handleCheckView({
      current,
      draft,
      asked,
      answer: { data: query.data, isError: query.isError, isFetching: query.isFetching },
    }),
    retry: () => {
      void query.refetch()
    },
  }
}
