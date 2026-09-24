import {
  CATALOG_LIMITS,
  externalSearchResponseSchema,
  searchCandidatesRequestSchema,
  searchCandidatesResponseSchema,
  type ExternalSearchResponse,
  type ExternalSearchResult,
  type WorkDetailResponse,
} from '@bookswap/shared'
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
 */
export async function searchExternalCatalogs(
  query: string,
  signal?: AbortSignal,
): Promise<ExternalSearchResponse> {
  return apiRequest(`/catalog/search/external?q=${encodeURIComponent(query)}`, {
    schema: externalSearchResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * The duplicate check could not be carried out.
 *
 * Its own error type because the caller must not confuse it with "no
 * duplicates found". Returning an empty list on a failed check is how a
 * duplicate silently gets created: the user is shown "nothing similar exists"
 * when in truth nobody looked.
 */
export class DuplicateCheckFailedError extends Error {
  /** The underlying validation issue, kept for diagnostics only. */
  readonly reason: unknown

  constructor(message: string, reason?: unknown) {
    super(message)
    this.name = 'DuplicateCheckFailedError'
    this.reason = reason
  }
}

/**
 * Cuts a string to `max` characters on a word boundary.
 *
 * A search query has an upper bound (`CATALOG_LIMITS.queryMax`) while an
 * external title has none, so a long title has to be shortened rather than
 * abandoned. The cut lands on a space so the tail of the query stays a whole
 * word — a ranker fed half a word matches worse than one fed fewer whole words.
 */
function truncateToWords(value: string, max: number): string {
  if (value.length <= max) return value

  const cut = value.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')

  return (lastSpace >= CATALOG_LIMITS.queryMin ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * The query used to re-search local candidates for a chosen external record.
 *
 * Title plus the FIRST author, not all of them: `q` is length-bounded and the
 * ranker (`rankWorks`) weighs the author match separately anyway. A book with
 * no known author is searched by title alone — a worse but honest query;
 * inventing an author the source never named is not allowed.
 *
 * The title wins the length budget. When title and author together exceed
 * `queryMax`, the author is dropped rather than the title truncated further:
 * the title is the stronger signal, and a half-title with an author attached
 * matches worse than a whole title on its own.
 */
export function candidateQueryFor(result: ExternalSearchResult): string {
  const title = truncateToWords(result.title.trim(), CATALOG_LIMITS.queryMax)
  const author = result.authors?.[0]?.trim()

  if (author === undefined || author === '') return title

  const combined = `${title} ${author}`

  return combined.length <= CATALOG_LIMITS.queryMax ? combined : title
}

/** Why a local work counts as a possible duplicate. */
export type DuplicateMatchKind = 'ISBN' | 'TITLE'

export interface DuplicateCheck {
  candidates: WorkDetailResponse[]
  /** `ISBN` only when the match came from an exact ISBN — a stronger claim. */
  matchedBy: DuplicateMatchKind | undefined
}

/**
 * One candidate search.
 *
 * A query that does not fit the shared contract throws instead of returning an
 * empty list. That distinction is the whole point: `[]` means "we looked and
 * found nothing", and a validation failure means "we could not look". Only the
 * caller, not this function, may decide what to do about the latter.
 */
async function candidatesFor(query: string): Promise<WorkDetailResponse[]> {
  const parsed = searchCandidatesRequestSchema.safeParse({ q: query })

  if (!parsed.success) {
    throw new DuplicateCheckFailedError(
      `Не вдалося скласти пошуковий запит із «${query.slice(0, 40)}…»`,
      parsed.error,
    )
  }

  const response = await apiRequest(
    `/catalog/search/candidates?q=${encodeURIComponent(parsed.data.q)}`,
    { schema: searchCandidatesResponseSchema },
  )

  return response.candidates
}

/**
 * The duplicate check before creation — §6.3 step 2, applied to an external
 * selection.
 *
 * Two independent attempts, both through the existing
 * `/catalog/search/candidates`:
 *
 * 1. **By ISBN, when the record has one.** That is the only match that really
 *    proves the same printing, so it runs first and its result is flagged
 *    separately (`matchedBy: 'ISBN'`).
 * 2. **By title and author.** Only a "this may already exist" hint: a title
 *    match proves nothing on its own — books have namesakes too. So the result
 *    is put to the user as a question rather than a settled conclusion, and is
 *    never selected automatically.
 *
 * Both branches return a list, not a single value: choosing among candidates
 * stays with the person.
 */
export async function findLocalDuplicates(result: ExternalSearchResult): Promise<DuplicateCheck> {
  if (result.isbn13 !== undefined) {
    const byIsbn = await candidatesFor(result.isbn13)

    if (byIsbn.length > 0) return { candidates: byIsbn, matchedBy: 'ISBN' }
  }

  const byTitle = await candidatesFor(candidateQueryFor(result))

  return {
    candidates: byTitle,
    matchedBy: byTitle.length > 0 ? 'TITLE' : undefined,
  }
}
