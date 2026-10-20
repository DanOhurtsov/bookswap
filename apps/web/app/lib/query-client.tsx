'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useSession, type SessionState } from './use-session'

/**
 * §3.9: mutations never retry on their own — an unsafe operation (PATCH with
 * `expectedRevision`) is not something the library repeats without a human
 * deciding to. Queries are not configured here: 8e-3 has none yet (`useWork`
 * stays the sole reader of Work data, R12); a later feature with real queries
 * (8f-3 CSV import) picks its own retry policy when it adds them.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
    },
  })
}

/**
 * One `QueryClient` per browser tab, created once via `useState` and never
 * replaced — not a module-level singleton, which would be shared across every
 * request on a server and, worse, across users (§3.9). This provider only
 * ever runs in the browser (`'use client'`, mounted from the root layout).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  const { state: session } = useSession()

  useCacheOfOneIdentity(queryClient, session)

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

/**
 * The cache is cleared when the authenticated identity changes in this same
 * tab (login as a different account, or logout) — otherwise a relogin would
 * still show the previous person's cached data. The very first resolved
 * session (loading → guest/authenticated) is not a "change": there is nothing
 * stale to clear yet.
 *
 * BS-140: the clear happens while `Providers` renders, before any child renders
 * for the new identity — not in an effect. Children's effects run before their
 * parent's, so with an effect a control that mounted for the new account had
 * already started its read, and the clear cancelled and dropped that read with
 * nothing left to start it again: the control stayed "loading" until some
 * unrelated re-render. Clearing first, the new identity's queries are created
 * in an empty cache, and nothing of the previous one is rendered even once.
 * The clear only notifies subscribers on a later tick (TanStack's
 * `notifyManager`), so no other component is updated during this render.
 *
 * The previous identity is state, not a ref, so the "seen it" update is the
 * React way of adjusting state to a changed input: `Providers` re-renders at
 * once, before its children.
 */
function useCacheOfOneIdentity(queryClient: QueryClient, session: SessionState): void {
  const [identity, setIdentity] = useState<{ known: boolean; userId: string | null }>({
    known: false,
    userId: null,
  })

  if (session.status === 'loading') return

  const userId = session.status === 'authenticated' ? session.user.id : null

  if (identity.known && identity.userId === userId) return

  if (identity.known) queryClient.clear()

  setIdentity({ known: true, userId })
}
