'use client'

import { skipToken, useQuery } from '@tanstack/react-query'
import { handleSchema, type PublicUser } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { fetchPersonByHandle, fetchPersonById } from '../api/person-requests'

/** The same words the API uses for its 404, for an address that cannot name anyone at all. */
const NOT_FOUND_MESSAGE = 'Користувача не знайдено'

export type PersonLookup = { handle: string } | { id: string }

export type PersonState =
  | { status: 'loading' }
  /** 404: no such person, or a blocked pair — the API answers both alike, and so does the page. */
  | { status: 'not-found'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; person: PublicUser }

/**
 * BS-148: the person an address names. Mount it only below the session guard: the API answers
 * signed-in viewers only, and whether a pair is blocked depends on who is asking.
 *
 * A nickname that cannot exist (`handleSchema` refuses it) is «not found» without a request: the
 * server would only answer 400 to it. A valid one is normalized first, so `/u/Marta` and `/u/marta`
 * share one cache entry.
 */
export function usePerson(lookup: PersonLookup): PersonState {
  const target = toTarget(lookup)

  const query = useQuery({
    queryKey: target === null ? ['person', 'invalid'] : ['person', target.by, target.value],
    queryFn:
      target === null
        ? skipToken
        : ({ signal }) =>
            target.by === 'handle'
              ? fetchPersonByHandle(target.value, signal)
              : fetchPersonById(target.value, signal),
    // A 404 is an answer, not a hiccup: retrying it only delays the "not found" page.
    retry: false,
  })

  if (target === null) return { status: 'not-found', message: NOT_FOUND_MESSAGE }

  if (query.data !== undefined) return { status: 'ready', person: query.data }

  if (query.isPending) return { status: 'loading' }

  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return { status: 'not-found', message: query.error.message }
  }

  return { status: 'error', message: describeError(query.error) }
}

function toTarget(lookup: PersonLookup): { by: 'handle' | 'id'; value: string } | null {
  if ('id' in lookup) return { by: 'id', value: lookup.id }

  const handle = handleSchema.safeParse(lookup.handle)

  return handle.success ? { by: 'handle', value: handle.data } : null
}
