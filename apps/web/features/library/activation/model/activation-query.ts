import type { QueryClient } from '@tanstack/react-query'

/**
 * Stage 8h-2, R12: one canonical key for one resource.
 *
 * Activation progress has exactly one shape and no parameters — it is always
 * «the caller's own count» — so the key carries nothing else. Every reader
 * (the library page, the add-book success screen, the committed import screen)
 * reads this key, and every writer invalidates this key; there is no second
 * cache and no per-screen variant that could disagree with the others.
 */
export const ACTIVATION_QUERY_KEY = ['activation'] as const

/**
 * What a successful mutation calls, instead of each call site spelling the key
 * out again. Three of them exist today — adding a copy, committing an import,
 * deleting a copy — and a fourth that spelled the key slightly differently
 * would silently invalidate nothing.
 *
 * Only ever after a confirmed success: a failed mutation changed no copies, so
 * the count on screen is still the true one and refetching it would be noise.
 */
export function invalidateActivation(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ACTIVATION_QUERY_KEY })
}
