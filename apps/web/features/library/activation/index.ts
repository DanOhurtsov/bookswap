/**
 * Server entry of the activation feature (CONVENTIONS.md §2.3).
 *
 * Separate from `index.client.ts` on purpose: this side reaches for
 * `next/headers` and forwards a session cookie, and a client module that
 * imported it transitively would fail at build time — which is the point.
 */
export { fetchActivationProgress } from './api/fetch-activation.server'
export type { ActivationInitialState } from './model/activation-state'
