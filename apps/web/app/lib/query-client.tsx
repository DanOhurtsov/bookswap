'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSession } from './use-session'

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
 *
 * The cache is cleared when the authenticated identity changes in this same
 * tab (login as a different account, or logout) — otherwise a relogin would
 * still show the previous person's cached data. The very first resolved
 * session (loading → guest/authenticated) is not a "change": there is nothing
 * stale to clear yet.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  const { state: session } = useSession()
  const identity = useRef<{ known: boolean; userId: string | null }>({
    known: false,
    userId: null,
  })

  useEffect(() => {
    if (session.status === 'loading') return

    const userId = session.status === 'authenticated' ? session.user.id : null

    if (identity.current.known && identity.current.userId !== userId) {
      queryClient.clear()
    }

    identity.current = { known: true, userId }
  }, [session, queryClient])

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
