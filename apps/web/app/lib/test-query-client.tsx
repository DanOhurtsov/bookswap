import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'

/**
 * Test-only counterpart to `query-client.tsx`'s `createQueryClient`: same
 * `retry: false` for mutations, plus `gcTime: 0` so nothing survives between
 * tests that render this wrapper more than once. A fresh instance per call —
 * tests must not share a `QueryClient`, or one spec's cache would leak into
 * the next.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, gcTime: 0 },
    },
  })
}

export function withQueryClient(
  children: ReactElement,
  client = createTestQueryClient(),
): ReactNode {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
