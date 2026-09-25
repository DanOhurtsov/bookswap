import {
  bookLookupResponseSchema,
  isValidIsbn13,
  normalizeIsbn13,
  searchCandidatesRequestSchema,
  searchCandidatesResponseSchema,
  type BookLookupResult,
  type WorkDetailResponse,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

type LookupOutcome = {
  lookup?: BookLookupResult
  lookupFailure?: unknown
}

export type AddBookSearchResult = LookupOutcome & {
  query: string
  candidates: WorkDetailResponse[]
  isbn?: string
  page: number
  pageSize: number
  /** Are there more of OUR rows after this page — a listed fact, not a guess. */
  hasMore: boolean
}

async function requestLookup(isbn: string | undefined): Promise<LookupOutcome> {
  if (isbn === undefined) return {}

  try {
    const response = await apiRequest(`/catalog/lookup?isbn=${encodeURIComponent(isbn)}`, {
      schema: bookLookupResponseSchema,
    })

    return { lookup: response.result }
  } catch (error) {
    // Lookup only suggests editable defaults; candidate search remains authoritative.
    return { lookupFailure: error }
  }
}

async function requestCandidates(
  query: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
) {
  return apiRequest(
    `/catalog/search/candidates?q=${encodeURIComponent(query)}&page=${String(page)}&pageSize=${String(pageSize)}`,
    { schema: searchCandidatesResponseSchema, ...(signal === undefined ? {} : { signal }) },
  )
}

/**
 * Runs catalog matching and optional ISBN enrichment as independent parallel
 * requests. The wizard's list is the SAME shared list as `/catalog`, paged by the
 * same `page`/`pageSize`; the duplicate check does not go through here.
 */
export async function searchAddBookCandidates(
  query: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<AddBookSearchResult> {
  const { q } = searchCandidatesRequestSchema.parse({ q: query, page, pageSize })
  const isbn = isValidIsbn13(q) ? normalizeIsbn13(q) : undefined

  const [response, lookupOutcome] = await Promise.all([
    requestCandidates(q, page, pageSize, signal),
    requestLookup(isbn),
  ])

  let candidates = response.candidates
  let hasMore = response.hasMore

  // An ISBN query can have no local hit while its external title already exists as a Work.
  // One title pass exposes that Work before the user creates a duplicate.
  if (
    isbn !== undefined &&
    page === 1 &&
    candidates.length === 0 &&
    lookupOutcome.lookup !== undefined
  ) {
    const titleQuery = searchCandidatesRequestSchema.safeParse({ q: lookupOutcome.lookup.title })

    if (titleQuery.success) {
      try {
        // A single best-effort pass, not a list to walk: nothing follows it.
        const byTitle = await requestCandidates(titleQuery.data.q, 1, pageSize, signal)

        candidates = byTitle.candidates
        hasMore = false
      } catch {
        // Exact external metadata is still useful; title dedup enrichment is best-effort.
      }
    }
  }

  return {
    query: q,
    candidates,
    page,
    pageSize,
    hasMore,
    ...(isbn === undefined ? {} : { isbn }),
    ...lookupOutcome,
  }
}
