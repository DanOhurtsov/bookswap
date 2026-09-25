'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CATALOG_LIMITS,
  catalogDiscoveryResponseSchema,
  workDetailResponseSchema,
  type CatalogDiscoveryResponse,
  type CatalogDiscoveryScope,
  type WorkDetailResponse,
} from '@bookswap/shared'
import { apiRequest, apiRequestWithRedirect, describeError } from './api'
import { askedFor } from './search-page'
import { useKeyedRequest } from './use-keyed-request'

/**
 * Ті самі три стани, що й у `useSession` та `useFriends`: «ще шукаю» і «нічого не
 * знайдено» — різні речі, і без цієї різниці сторінка блимає написом «нічого не
 * знайдено» при кожному натисканні.
 */
export type CatalogDiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: CatalogDiscoveryResponse }
  | { status: 'error'; message: string }

/**
 * Discovery of physical copies for the selected viewer scope and URL page.
 * An empty query stays idle; stale responses never render for another key.
 */
export function useCatalogDiscovery(
  query: string,
  page: number,
  pageSize: number,
  scope: CatalogDiscoveryScope,
  refresh = 0,
): CatalogDiscoveryState {
  const trimmed = query.trim()
  const enabled = trimmed.length >= CATALOG_LIMITS.queryMin

  const key = `${scope}\u0000${String(refresh)}\u0000${askedFor(trimmed, page, pageSize)}`
  const state = useKeyedRequest(enabled ? key : undefined, (signal) =>
    apiRequest(
      `/catalog/discover?q=${encodeURIComponent(trimmed)}&page=${String(page)}&pageSize=${String(pageSize)}&scope=${scope}`,
      { schema: catalogDiscoveryResponseSchema, signal },
    ),
  )

  if (state.status === 'ready') return { status: 'ready', response: state.value }
  if (state.status === 'error') return { status: 'error', message: describeError(state.error) }

  return state
}

export type WorkState =
  | { status: 'loading' }
  | { status: 'ready'; detail: WorkDetailResponse }
  | { status: 'error'; message: string }

/**
 * R12 (`docs/plan/stage-8-inventory.md`): what a `reload()` call resolves to.
 * `useApiResource.reload()` always resolves, success or failure alike — fine
 * for "unblock the button either way", but not enough once a caller needs to
 * tell "the refresh itself failed" apart from "it never got an answer". Three
 * distinct outcomes, not a boolean:
 *
 * - `success` — a fresh snapshot was received AND accepted (parsed, not
 *   aborted, still the current generation) — not merely "the fetch settled".
 * - `error` — the refresh request itself failed (HTTP or network).
 * - `cancelled` — this specific call never got an answer: a later `reload()`
 *   (or a `workId` change) superseded it before its request completed, or the
 *   component unmounted first. It is NOT adopted by whichever request
 *   replaced it — each call resolves strictly for the request it caused.
 */
export type WorkReloadOutcome =
  { status: 'success' } | { status: 'error'; message: string } | { status: 'cancelled' }

type ReloadWaiter = (outcome: WorkReloadOutcome) => void

export interface WorkResource {
  state: WorkState
  reload: () => Promise<WorkReloadOutcome>
  /**
   * The canonical work id when this request was answered off a merged one —
   * `null` otherwise. §6.3 makes that a 301, `fetch` follows it, and the page
   * uses this to move the browser's URL along with the data.
   */
  canonicalWorkId: string | null
}

export function useWork(workId: string): WorkResource {
  // Stored together with the id it resulted from, same idiom as `moved`
  // below and `useCatalogDiscovery` above: otherwise a workId change (navigating
  // to a different book) would keep showing the PREVIOUS book's `ready`
  // detail — including its title, authors, everything — for as long as the
  // new book's own fetch takes, instead of `loading`.
  const [stored, setStored] = useState<{ workId: string; state: WorkState }>({
    workId,
    state: { status: 'loading' },
  })
  const [nonce, setNonce] = useState(0)
  // Stored together with the id it was observed for, like the search state
  // above: otherwise a redirect seen for one work would still look current
  // after the caller moved on to another, and the page would bounce the URL to
  // a book nobody asked for.
  const [moved, setMoved] = useState<{ requestedWorkId: string; canonicalWorkId: string }>()

  // Waiters registered by `reload()` calls that have not yet been claimed by a
  // request. A call made while a request is already in flight lands here and
  // is claimed by the NEXT effect run (next `nonce`/`workId`), not the current
  // one — see `reload` below.
  const pending = useRef<ReloadWaiter[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    const controller = new AbortController()
    // This run claims whatever was waiting when it started; only it may
    // settle these — see the guard in the effect below.
    const claimed = pending.current

    pending.current = []

    let settled = false

    function resolveClaimed(outcome: WorkReloadOutcome): void {
      if (settled) return

      settled = true

      for (const resolve of claimed.splice(0)) resolve(outcome)
    }

    async function load(): Promise<void> {
      try {
        const { data: detail, redirected } = await apiRequestWithRedirect(
          `/works/${encodeURIComponent(workId)}`,
          { schema: workDetailResponseSchema, signal: controller.signal },
        )

        // Superseded before the response arrived: the cleanup below already
        // resolved `claimed` as `cancelled`. Writing state here would render
        // an answer nobody asked for anymore.
        if (controller.signal.aborted) return

        setStored({ workId, state: { status: 'ready', detail } })
        setMoved(
          redirected ? { requestedWorkId: workId, canonicalWorkId: detail.work.id } : undefined,
        )
        resolveClaimed({ status: 'success' })
      } catch (error) {
        if (controller.signal.aborted) return

        const message = describeError(error)

        // A `reload()` that fails is not the same event as the first load for
        // THIS work failing: the page already has a good snapshot of THIS
        // work on screen (possibly just confirmed by a successful PATCH), and
        // blanking it out behind a full error screen would make a successful
        // save look like a failed one. Only replace the state when there is
        // no known-good detail yet for this same workId — a failed load for a
        // DIFFERENT work (navigated here mid-flight) must still show its own
        // error, not the previous book's stale `ready` state.
        setStored((current) =>
          current.workId === workId && current.state.status === 'ready'
            ? current
            : { workId, state: { status: 'error', message } },
        )
        resolveClaimed({ status: 'error', message })
      }
    }

    void load()

    return () => {
      // Either a newer `reload()`/`workId` change preempted this request, or
      // the component is unmounting: this run's own request is not getting an
      // answer it can act on, so its waiters are told exactly that — not
      // adopted by whatever replaces it.
      controller.abort()
      resolveClaimed({ status: 'cancelled' })
    }
  }, [workId, nonce])

  // Separate lifecycle effect, same reason as `useApiResource`: in StrictMode
  // React mounts, unmounts and remounts the same hook instance synchronously,
  // and `mounted` must read `true` again after that remount, not stay `false`
  // forever.
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false

      for (const resolve of pending.current.splice(0)) resolve({ status: 'cancelled' })
    }
  }, [])

  const reload = useCallback((): Promise<WorkReloadOutcome> => {
    if (!mounted.current) return Promise.resolve({ status: 'cancelled' })

    return new Promise<WorkReloadOutcome>((resolve) => {
      pending.current.push(resolve)
      setNonce((value) => value + 1)
    })
  }, [])

  return {
    // A response to a different workId is not yet a response to this one.
    state: stored.workId === workId ? stored.state : { status: 'loading' },
    reload,
    canonicalWorkId: moved?.requestedWorkId === workId ? moved.canonicalWorkId : null,
  }
}
