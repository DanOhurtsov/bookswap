import {
  readingStatsResponseSchema,
  readingStatusResponseSchema,
  readingStatusesResponseSchema,
  setReadingStatusResponseSchema,
  type ReadingStatus,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * Stage 10 (10j.2, T13). Усі маршрути — `/me/*`: користувач береться лише з сесії, тож
 * чужого статусу цими запитами отримати неможливо (R-8).
 */

const statusPath = (workId: string) => `/me/reading-statuses/${encodeURIComponent(workId)}`

export const fetchReadingStatus = (workId: string, signal?: AbortSignal) =>
  apiRequest(statusPath(workId), { schema: readingStatusResponseSchema, signal })

/** BS-140: many works in one request; `workIds` are unique and at most `READING_STATUS_BATCH_LIMITS.idsMax`. */
export const fetchReadingStatuses = (workIds: readonly string[]) =>
  apiRequest(`/me/reading-statuses?workIds=${workIds.map(encodeURIComponent).join(',')}`, {
    schema: readingStatusesResponseSchema,
  })

export const saveReadingStatus = (workId: string, status: ReadingStatus) =>
  apiRequest(statusPath(workId), {
    method: 'PUT',
    body: { status },
    schema: setReadingStatusResponseSchema,
  })

/** BS-145: the counts for the home page — the browser's half of `fetchReadingStatsSnapshot`. */
export const fetchReadingStats = (signal?: AbortSignal) =>
  apiRequest('/me/reading-stats', { schema: readingStatsResponseSchema, signal })
