import type { ActivationResponse } from '@bookswap/shared'

/**
 * Stage 8h-2, R11: what the server managed to learn about activation progress
 * before the page was sent, in a shape that survives the RSC boundary (§2.5 —
 * plain data only, no Response, no Error, no schema instance).
 *
 * Three cases rather than `ActivationResponse | null`, because the client does
 * different things with them: `ready` seeds the query, `guest` means there is
 * no checklist to show at all, and `error` means the server could not answer —
 * the browser may still be able to, so it simply starts without a seed.
 */
export type ActivationInitialState =
  { status: 'ready'; data: ActivationResponse } | { status: 'guest' } | { status: 'error' }
