/**
 * Server entry of the reading-status feature (CONVENTIONS.md §2.3). Separate from `index.client.ts`:
 * this side reaches for `next/headers` and forwards a session cookie.
 */
export { fetchReadingStatsSnapshot } from './api/fetch-reading-stats.server'
export type { ReadingStatsSnapshot } from './model/reading-stats-view'
