'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { sessionResponseSchema, type Me, type SessionFeatures } from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from './api'

/**
 * Три стани, а не `user | null`: «ще перевіряю» і «точно гість» — різні речі.
 * Без цієї різниці захищена сторінка блимає формою логіну на кожному оновленні.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'guest' }
  // `features` comes from the server (T9); absent means unknown, and every consumer
  // must treat unknown as off.
  | { status: 'authenticated'; user: Me; features?: SessionFeatures }
  | { status: 'error'; message: string }

export interface SessionApi {
  state: SessionState
  reload: () => void
  /** `features` omitted keeps the ones already known (e.g. after a profile edit). */
  setUser: (user: Me, features?: SessionFeatures) => void
  /** Explicit "I just confirmed with the server that no one is logged in" — see `setGuest` below. */
  setGuest: () => void
}

/**
 * 8e-3 follow-up: this used to be a plain hook, fetching `/auth/session`
 * independently in every component that called it — `NavBar`, every page,
 * and `Providers` (`query-client.tsx`) each held their OWN snapshot. A login
 * or logout anywhere else in the tab never reached the others: `NavBar`
 * (mounted once, in the root layout) kept showing the previous identity
 * after a client-side navigation, and `Providers` had no way to know the
 * user changed at all, so it could never clear the query cache on relogin.
 *
 * One `SessionProvider` (mounted once, in `layout.tsx`) now owns the fetch;
 * `useSession()` just reads its context. `register`/`login` call `setUser`
 * directly after a successful response; `logout` calls `setGuest` directly
 * after a successful `/auth/logout` — neither waits for (or depends on) a
 * fresh `/auth/session` GET to notice the change on its own.
 */
const SessionContext = createContext<SessionApi | undefined>(undefined)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  // Bumped by every state-setting path (a fetch settling, `setUser`,
  // `setGuest`) — not just by `reload()`'s own `nonce`. A GET started on
  // mount (or by an earlier `reload()`) is not aborted by `setUser`/`setGuest`
  // — nothing cancels its network request — so without this check, that GET
  // resolving AFTER login/logout would silently overwrite the identity they
  // just set, with EITHER a success or a 401-turned-guest answer.
  const generation = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const thisGeneration = ++generation.current

    async function load(): Promise<void> {
      try {
        const { user, features } = await apiRequest('/auth/session', {
          schema: sessionResponseSchema,
          signal: controller.signal,
        })

        if (controller.signal.aborted || generation.current !== thisGeneration) return

        setState({ status: 'authenticated', user, features })
      } catch (error) {
        if (controller.signal.aborted || generation.current !== thisGeneration) return

        // 401 — це не збій, а відповідь «ти не залогінений».
        if (error instanceof ApiRequestError && error.status === 401) {
          setState({ status: 'guest' })
          return
        }

        setState({ status: 'error', message: describeError(error) })
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [nonce])

  const reload = useCallback(() => {
    setNonce((value) => value + 1)
  }, [])

  const setUser = useCallback((user: Me, features?: SessionFeatures) => {
    generation.current += 1
    setState((previous) => ({
      status: 'authenticated',
      user,
      features: features ?? (previous.status === 'authenticated' ? previous.features : undefined),
    }))
  }, [])

  const setGuest = useCallback(() => {
    generation.current += 1
    setState({ status: 'guest' })
  }, [])

  return (
    <SessionContext.Provider value={{ state, reload, setUser, setGuest }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionApi {
  const context = useContext(SessionContext)

  if (context === undefined) {
    throw new Error('useSession() потребує <SessionProvider> — див. app/layout.tsx')
  }

  return context
}
