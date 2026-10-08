import { externalSearchResponseSchema, type ExternalSearchResponse } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * Title search across external catalogs — a separate request, not part of
 * `searchAddBookCandidates`.
 *
 * Deliberately separate. Local candidates must appear at once, regardless of
 * whether external sources are alive or how long they think; glued into one
 * `Promise.all` they would wait for the slowest. Two independent requests with
 * their own states are exactly the "local results do not depend on external
 * speed" requirement.
 *
 * `page` and `pageSize` are always sent explicitly, even for the first page. The
 * two halves of one list must be asked for the SAME page, and leaving it to a
 * default on one side is how they would silently drift apart.
 */
export async function searchExternalCatalogs(
  query: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<ExternalSearchResponse> {
  return apiRequest(
    `/catalog/search/external?q=${encodeURIComponent(query)}&page=${String(page)}&pageSize=${String(pageSize)}`,
    {
      schema: externalSearchResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    },
  )
}
