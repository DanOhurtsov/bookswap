import { READING_STATUS, type ReadingStatsResponse, type ReadingStatus } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { READING_STATUS_LABELS } from '@/app/lib/labels'

/**
 * BS-145: what the server learned about the viewer's reading stats before the page was sent, in a
 * shape that survives the RSC boundary (§2.5). `ready` names the user it was read for: the client
 * seeds only that user's cache entry with it, never another session's.
 */
export type ReadingStatsSnapshot =
  | { status: 'ready'; userId: string; data: ReadingStatsResponse }
  | { status: 'guest' }
  | { status: 'error' }

export type ReadingStatsView =
  | { kind: 'loading' }
  /** Never shown as zeros: a count we failed to read is not a count of nothing. */
  | { kind: 'error'; message: string }
  /** No status set at all — an invitation to set one, not three zeros. */
  | { kind: 'empty' }
  /** All three statuses in their usual order, zeros included. */
  | { kind: 'ready'; items: { status: ReadingStatus; label: string; count: number }[] }

export interface ReadingStatsViewInput {
  data: ReadingStatsResponse | undefined
  error: unknown
  isError: boolean
  /**
   * The entry was marked out of date by a saved status and is being read again. Its counts are known
   * to be stale, so they wait for the new answer rather than flash on screen first.
   */
  isRefreshingOutdated: boolean
}

const LOAD_FAILED = 'Не вдалося завантажити статистику читання.'

export function toReadingStatsView({
  data,
  error,
  isError,
  isRefreshingOutdated,
}: ReadingStatsViewInput): ReadingStatsView {
  // Before the data: after a failed refresh the last counts are still cached, and showing them under
  // a heading that describes the reading now would present a stale count as the current one.
  if (isError) return { kind: 'error', message: `${LOAD_FAILED} ${describeError(error)}` }
  if (data === undefined || isRefreshingOutdated) return { kind: 'loading' }

  const items = READING_STATUS.map((status) => ({
    status,
    label: READING_STATUS_LABELS[status],
    count: data.counts[status],
  }))

  return items.every((item) => item.count === 0) ? { kind: 'empty' } : { kind: 'ready', items }
}
