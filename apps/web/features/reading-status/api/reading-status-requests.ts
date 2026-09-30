import {
  readingListResponseSchema,
  readingStatusResponseSchema,
  setReadingStatusResponseSchema,
  type ReadingListStatus,
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

export const saveReadingStatus = (workId: string, status: ReadingStatus) =>
  apiRequest(statusPath(workId), {
    method: 'PUT',
    body: { status },
    schema: setReadingStatusResponseSchema,
  })

export interface ReadingListPageQuery {
  status: ReadingListStatus | undefined
  cursor: string | undefined
}

export const fetchReadingList = (
  { status, cursor }: ReadingListPageQuery,
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams()

  if (status !== undefined) params.set('status', status)
  if (cursor !== undefined) params.set('cursor', cursor)

  const query = params.toString()

  return apiRequest(`/me/reading-list${query === '' ? '' : `?${query}`}`, {
    schema: readingListResponseSchema,
    signal,
  })
}
