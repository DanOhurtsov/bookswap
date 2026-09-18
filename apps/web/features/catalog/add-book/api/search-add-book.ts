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

async function requestCandidates(query: string) {
  return apiRequest(`/catalog/search/candidates?q=${encodeURIComponent(query)}`, {
    schema: searchCandidatesResponseSchema,
  })
}

/** Runs catalog matching and optional ISBN enrichment as independent parallel requests. */
export async function searchAddBookCandidates(query: string): Promise<AddBookSearchResult> {
  const { q } = searchCandidatesRequestSchema.parse({ q: query })
  const isbn = isValidIsbn13(q) ? normalizeIsbn13(q) : undefined

  const [response, lookupOutcome] = await Promise.all([requestCandidates(q), requestLookup(isbn)])

  let candidates = response.candidates

  // An ISBN query can have no local hit while its external title already exists as a Work.
  // One title pass exposes that Work before the user creates a duplicate.
  if (isbn !== undefined && candidates.length === 0 && lookupOutcome.lookup !== undefined) {
    const titleQuery = searchCandidatesRequestSchema.safeParse({ q: lookupOutcome.lookup.title })

    if (titleQuery.success) {
      try {
        candidates = (await requestCandidates(titleQuery.data.q)).candidates
      } catch {
        // Exact external metadata is still useful; title dedup enrichment is best-effort.
      }
    }
  }

  return {
    query: q,
    candidates,
    ...(isbn === undefined ? {} : { isbn }),
    ...lookupOutcome,
  }
}
