'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ActivationResponse } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { fetchActivation } from '../api/activation-requests'
import { ACTIVATION_QUERY_KEY } from './activation-query'
import type { ActivationInitialState } from './activation-state'

/**
 * How long a freshly rendered count is trusted without asking again.
 *
 * Without it, a server-rendered page would immediately refetch what it just
 * embedded — two requests per load for one number. Invalidation is unaffected:
 * `invalidateQueries` marks the entry stale whatever this value is, so a book
 * added, imported or deleted still moves the checklist at once.
 */
const ACTIVATION_STALE_MS = 30_000

/**
 * Shown when the server could not read the count at all. There is no exception
 * to quote here — the failure happened in another process, and its details are
 * deliberately not carried across (they can contain the session cookie).
 */
const SERVER_READ_FAILED = 'Не вдалося прочитати прогрес.'

/**
 * Whether an automatic refetch may run, given how the query currently stands.
 *
 * `retry: false` only stops TanStack Query from repeating a failed attempt on
 * its own; it says nothing about the triggers that start a NEW fetch. An
 * errored query is still enabled and still stale, so focus, reconnect and a
 * fresh observer would each quietly re-ask the question a person was just told
 * had failed — and the «Спробувати ще раз» button would stop being the thing
 * that decides when to ask.
 *
 * So the triggers are gated on the error state rather than switched off: once
 * an answer has arrived, freshness works exactly as it does everywhere else.
 */
function isNotErrored(query: { state: { status: 'pending' | 'success' | 'error' } }): boolean {
  return query.state.status !== 'error'
}

export type ActivationView =
  /** Nobody to show progress to, or the page is already reporting a session problem. */
  | { status: 'hidden' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; progress: ActivationResponse }

export interface Activation {
  view: ActivationView
  /** Manual retry after an error. The only thing that repeats a failed read. */
  retry: () => void
}

/**
 * Stage 8h-2, R11: the single reader of activation progress.
 *
 * `initial` is a seed, not a second source of truth: when the server managed
 * to read the count it becomes the query's `initialData` and therefore simply
 * IS the cache entry. Nothing keeps a parallel copy in state, so there is no
 * pair of values that can drift apart.
 *
 * A guest neither shows a checklist nor asks for one. That is what keeps a
 * logged-out visitor from a 401-and-retry loop: the query is disabled outright
 * rather than firing and failing, and even when it does fail, `retry: false`
 * means it fails once and waits for a person to ask again.
 *
 * **A server-side failure is a state, not a missing seed.** It used to be
 * treated as «no `initialData`», which quietly did the opposite of what the
 * server had just found out: the browser fired the same request again on
 * hydration, and — where something had already put a count in the cache — the
 * page showed that older number as if it were current. Neither is honest. When
 * the server could not read the count, the answer is «we do not know», shown as
 * an error with a retry, and nothing is fetched until a person asks.
 */
export function useActivation(initial?: ActivationInitialState): Activation {
  const { state: session } = useSession()
  /**
   * The one piece of local state here, and it holds no data — only the fact
   * that a person pressed «Спробувати ще раз» after a server-side failure.
   * Without it there is nothing to distinguish «the server failed and nobody
   * asked again» from «the server failed and we are now retrying», and those
   * two must not fetch alike.
   */
  const [hasRequestedRetry, setHasRequestedRetry] = useState(false)

  const serverReadFailed = initial?.status === 'error'
  /** Server said it does not know, and nobody has asked the browser to find out. */
  const isBlockedByServerError = serverReadFailed && !hasRequestedRetry

  // `error` hides too: the screen that owns the session already reports it, and
  // a second copy of the same message under a progress bar helps nobody.
  const isHidden =
    session.status === 'guest' ||
    session.status === 'error' ||
    // The server already knows there is no session; waiting for the browser to
    // rediscover that would flash a loading checklist at an anonymous visitor.
    (session.status === 'loading' && initial?.status === 'guest')

  const query = useQuery({
    queryKey: ACTIVATION_QUERY_KEY,
    queryFn: ({ signal }) => fetchActivation(signal),
    enabled: session.status === 'authenticated' && !isBlockedByServerError,
    // §3.9 allows a considered retry on GET; this is not one. The failure modes
    // here are 401 and «API unreachable», and repeating either on the user's
    // behalf only delays an honest message behind a spinner.
    retry: false,
    // After a failed server read, whatever sits in the cache is exactly what we
    // have decided not to trust — so it is stale by definition, and enabling the
    // query on retry fetches once instead of handing back the old number.
    staleTime: serverReadFailed ? 0 : ACTIVATION_STALE_MS,
    // Only while the last answer was an error. A successful, merely stale count
    // still refreshes on focus and on reconnect like any other query, and
    // `invalidateQueries` after an add, import or delete is unaffected either
    // way — it refetches active observers directly, not through these.
    refetchOnWindowFocus: isNotErrored,
    refetchOnReconnect: isNotErrored,
    refetchOnMount: isNotErrored,
    // The mount path needs both: `refetchOnMount` covers a query that errored
    // while holding an older count, and `retryOnMount` covers one that errored
    // with no data at all — TanStack checks them in different branches.
    retryOnMount: false,
    ...(initial?.status === 'ready' ? { initialData: initial.data } : {}),
  })

  return {
    view: toView({ isHidden, isBlockedByServerError, serverReadFailed, query }),
    retry: () => {
      if (isBlockedByServerError) {
        // Enabling the query is the fetch: it is stale (see `staleTime` above),
        // so this starts exactly one request and never replays the server's.
        setHasRequestedRetry(true)

        return
      }

      void query.refetch()
    },
  }
}

interface ViewInput {
  isHidden: boolean
  isBlockedByServerError: boolean
  serverReadFailed: boolean
  query: {
    isError: boolean
    isFetching: boolean
    error: unknown
    data: ActivationResponse | undefined
  }
}

function toView({
  isHidden,
  isBlockedByServerError,
  serverReadFailed,
  query,
}: ViewInput): ActivationView {
  if (isHidden) return { status: 'hidden' }

  // Before anything is read from the query, deliberately: there may well be a
  // cached count sitting under this key, and after a failed server read we have
  // no reason to believe it still describes the shelf.
  if (isBlockedByServerError) return { status: 'error', message: SERVER_READ_FAILED }

  // Same reasoning, one step later: during the manual retry the old value is
  // still in the cache, and showing it would answer the question the person
  // just asked with the number they already distrusted.
  if (serverReadFailed && query.isFetching) return { status: 'loading' }

  // After a failed refetch TanStack Query still holds the last successful
  // answer, and showing it under a heading that claims to describe the shelf
  // right now would be presenting a stale count as a current one.
  if (query.isError) {
    return { status: 'error', message: `Не вдалося оновити прогрес. ${describeError(query.error)}` }
  }
  if (query.data !== undefined) return { status: 'ready', progress: query.data }

  return { status: 'loading' }
}
