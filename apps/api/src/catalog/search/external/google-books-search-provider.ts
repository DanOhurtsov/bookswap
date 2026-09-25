import { Injectable } from '@nestjs/common'
import { isLanguageCode, isValidIsbn13, normalizeIsbn13, relevanceOf } from '@bookswap/shared'
import type { ExternalSearchResult } from '@bookswap/shared'
import {
  extractPublishedYear,
  nonEmptyString,
  normalizedCoverUrl,
  plainTextDescription,
  positivePageCount,
  stringArray,
} from '../../lookup/lookup-provider.utils'
import {
  ExternalSearchProviderError,
  ExternalSearchTimeoutError,
  type ExternalSearchBlock,
  type ExternalSearchBlockResult,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { searchTerms } from './search-terms'

const API_ROOT = 'https://www.googleapis.com/books/v1/volumes'

/**
 * The documented `maxResults` ceiling is 40
 * (https://developers.google.com/books/docs/v1/using). A block wider than this
 * is clamped, and the clamped width is also what `startIndex` advances by — so
 * the blocks stay adjacent instead of leaving a hole in the stream.
 */
const MAX_RESULTS_CAP = 40

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The ISBN-13 of this very volume.
 *
 * A Google Books volume's `industryIdentifiers` describes ONE printing — unlike
 * the aggregated `isbn` of an Open Library document — so taking an ISBN from
 * here is correct. The value is still checksum-verified: an `ISBN_13` type also
 * shows up on an empty or corrupted string, and an invalid ISBN would not pass
 * the contract schema downstream.
 */
function isbn13From(info: Record<string, unknown>): string | undefined {
  if (!Array.isArray(info.industryIdentifiers)) return undefined

  for (const entry of info.industryIdentifiers) {
    const record = asRecord(entry)
    if (record?.type !== 'ISBN_13') continue

    const value = nonEmptyString(record.identifier)
    if (value === undefined || !isValidIsbn13(value)) continue

    return normalizeIsbn13(value)
  }

  return undefined
}

function coverUrlFrom(info: Record<string, unknown>): string | undefined {
  const links = asRecord(info.imageLinks)
  if (links === undefined) return undefined

  for (const key of ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail']) {
    const url = normalizedCoverUrl(links[key])
    if (url !== undefined) return url
  }

  return undefined
}

/**
 * How many requests one search may spend on this provider.
 *
 * Three. The bound is not arbitrary: the source has a single deadline
 * (`CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS`, 4s by default) and the outbound
 * limiter holds a minimum interval between calls (1s), so the third request
 * starts around two seconds in and still has room to answer. A fourth would
 * routinely turn a working search into a `TIMEOUT`, which costs the user every
 * result rather than the last one.
 */
const QUERY_BUDGET = 3

/**
 * The field-restricted queries for one search — ALL of them are sent.
 *
 * Google Books has no boolean OR (`a OR b` is parsed as a third term, which the
 * provider's own answers confirm), so the single cross-field query Open Library
 * accepts cannot be written here. The readings of an input are therefore
 * separate requests:
 *
 * 1. **The whole query is a title.** Each term gets its own `intitle:"…"`:
 *    unquoted, the operator binds only the term immediately after it and the
 *    rest silently become a full-text search — the very thing being fixed.
 * 2. **One term is part of an author's name** — `inauthor:"<term>"`, with no
 *    title constraint at all. The relevance gate then requires every OTHER
 *    term to appear in that book's title or authors, so this one query answers
 *    "Тигролови Багряний" and "Багряний Тигролови" identically. Position is
 *    never consulted, and the query never says which word the author is; it
 *    asks Google for one author's books and lets the gate decide.
 *
 * There used to be a single "the last word is the author" query. That
 * assumption is gone: it could not see "Багряний Тигролови", and the terms are
 * now probed by how distinctive they are (longest first — a surname outlasts
 * "і" and "та"), not by where they sit.
 *
 * Every query runs; none is conditional on another finding nothing. That is
 * deliberate and is the second bug this replaces: "Багряний" matches the TITLE
 * of several books about Ivan Bahrianyi, so a plan that stopped at the first
 * non-empty answer returned the biographies and never asked for the author's
 * own novels.
 */
function queryPlan(terms: readonly string[]): string[] {
  const titleQuery = terms.map((term) => `intitle:"${term}"`).join(' ')

  // Longest first: a surname carries more than a conjunction, and length is
  // the only signal available without a corpus. Ties keep the typed order so
  // the plan is deterministic.
  const probes = [...new Set(terms)]
    .map((term, index) => ({ term, index }))
    .sort((left, right) => right.term.length - left.term.length || left.index - right.index)
    .slice(0, QUERY_BUDGET - 1)
    .map(({ term }) => `inauthor:"${term}"`)

  return [titleQuery, ...probes]
}

/**
 * Title search through the Google Books Volumes API.
 *
 * Every volume is an `EDITION`: it has its own `industryIdentifiers`,
 * publisher, year and page count, i.e. one specific printing. That is precisely
 * why an ISBN may be taken from here but not from Open Library's `search.json`
 * (see `open-library-search-provider.ts`).
 *
 * The query is field-restricted (`intitle:`/`inauthor:`) and never sent as free
 * text — see `queryPlan`. A bare `q=` here searches the CONTENTS of books, and
 * that single fact is what filled the wizard with lesson plans and test
 * booklets: they are the volumes that happen to mention a novel's name inside.
 *
 * The key (`GOOGLE_BOOKS_API_KEY`) is read from the SERVER environment and
 * never reaches the browser: the client only ever calls our own
 * `/catalog/search/external`. Without a key the request is still sent — the
 * documentation asks that requests be identified, and without one Google may
 * answer `429`; the source is then simply reported as unavailable.
 */
@Injectable()
export class GoogleBooksSearchProvider implements ExternalSearchProvider {
  readonly source = 'GOOGLE_BOOKS' as const

  /**
   * Runs the whole plan and unions what survives the relevance gate.
   *
   * Union, not "first non-empty wins". Google answers almost anything with
   * something, and a title hit is not evidence that the author reading is
   * pointless — "Багряний" is both a surname and the title of books about him,
   * and a person typing it wants the novels at least as much as the
   * biographies. Both readings are therefore always asked and shown together;
   * `mergeResults` orders them by relevance afterwards.
   *
   * A query that fails does not sink the ones that worked: the error is
   * re-thrown when NOTHING came back (the one case where "found nothing" and
   * "could not ask" would otherwise be confused), and otherwise handed to the
   * service as `partialFailure` so the block is not reported `OK` or cached.
   */
  async search(
    query: string,
    block: ExternalSearchBlock,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchBlockResult> {
    const terms = searchTerms(query)

    // Pure punctuation: there is no field to restrict to, and an empty query
    // would be the unrestricted full-text search this provider must not run.
    if (terms.length === 0) return { results: [], exhausted: true }

    const maxResults = Math.min(block.size, MAX_RESULTS_CAP)
    const startIndex = block.index * maxResults

    const seen = new Set<string>()
    const found: ExternalSearchResult[] = []
    let failure: Error | undefined
    // Only a query that came back SHORT proves its own end. Anything else —
    // a failed query, one skipped past the deadline, one that filled its window
    // — leaves the stream possibly longer, and the plan as a whole is exhausted
    // only when every one of its queries is.
    let exhausted = true

    for (const planned of queryPlan(terms)) {
      // The deadline belongs to the whole source, so once it has passed there
      // is nobody left to answer: returning what we already have beats
      // spending a rate-limit slot on a response nobody will read.
      if (context.signal.aborted) {
        exhausted = false
        failure ??= new ExternalSearchTimeoutError('deadline passed before the plan finished')
        break
      }

      try {
        // Inside the `try` on purpose: a refused slot (our own limiter) on the
        // second query must not throw away what the first one already found —
        // it is a partial failure like any other.
        await context.acquire()

        const page = await this.fetchVolumes(planned, startIndex, maxResults, context.signal)

        // Judged on RAW volumes: a window the gate emptied is not the end of
        // the stream, and counting the survivors would make it look like one.
        if (page.returned >= maxResults) exhausted = false

        for (const result of page.results) {
          if (seen.has(result.id) || !relevanceOf(query, result).matched) continue

          seen.add(result.id)
          found.push(result)
        }
      } catch (error) {
        // `fetchVolumes` only ever throws `ExternalSearchProviderError`; the
        // wrap is here so the rethrow below is typed as an error, not `unknown`.
        failure ??= error instanceof Error ? error : new ExternalSearchProviderError(String(error))
        exhausted = false
      }
    }

    if (found.length === 0 && failure !== undefined) throw failure

    // Nothing is truncated here. Every gated volume of the block goes into the
    // service's pool and gets a page; dropping the tail would lose it for good,
    // because the next block starts at a deeper `startIndex`.
    //
    // A failure with survivors is reported, not swallowed: the block is missing
    // part of its plan, so it is neither "fully OK" nor cacheable as complete.
    return {
      results: found,
      exhausted,
      ...(failure === undefined ? {} : { partialFailure: failure }),
    }
  }

  /**
   * One query of the plan, at one depth.
   *
   * The SAME `startIndex` goes to every query of the plan: the provider's
   * visible stream is their union, and a union has no single cursor to advance.
   *
   * `returned` is the count of RAW volumes, kept apart from `results` (those
   * that parsed) on purpose — it is what decides whether the window was full,
   * and the survivors' count would answer a different question. Google's own
   * `totalItems` is not consulted at all: it is documented as an estimate and
   * changes between identical requests.
   */
  private async fetchVolumes(
    query: string,
    startIndex: number,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<{ results: ExternalSearchResult[]; returned: number }> {
    const url = new URL(API_ROOT)
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(maxResults))
    url.searchParams.set('startIndex', String(startIndex))
    url.searchParams.set('printType', 'books')
    url.searchParams.set('projection', 'full')

    const apiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim()
    if (apiKey !== undefined && apiKey !== '') url.searchParams.set('key', apiKey)

    let response: Response

    try {
      response = await fetch(url, { signal })
    } catch (error) {
      throw new ExternalSearchProviderError(
        error instanceof Error ? error.message : 'мережева помилка',
      )
    }

    if (!response.ok) {
      throw new ExternalSearchProviderError(`Google Books відповів HTTP ${String(response.status)}`)
    }

    const body = asRecord(await response.json().catch(() => undefined))
    if (body === undefined) {
      throw new ExternalSearchProviderError('Google Books повернув тіло, що не є JSON-об’єктом')
    }

    // Empty results arrive with no `items` at all — that is "found nothing",
    // not a broken answer.
    if (!Array.isArray(body.items)) return { results: [], returned: 0 }

    return {
      results: body.items
        .map((item) => this.toResult(item))
        .filter((result): result is ExternalSearchResult => result !== undefined),
      returned: body.items.length,
    }
  }

  /** A volume with no title or no id is skipped — the rest of the results are unaffected. */
  private toResult(item: unknown): ExternalSearchResult | undefined {
    const volume = asRecord(item)
    const info = asRecord(volume?.volumeInfo)
    const externalId = nonEmptyString(volume?.id)
    const title = nonEmptyString(info?.title)

    if (info === undefined || externalId === undefined || title === undefined) return undefined

    const authors = stringArray(info.authors)
    const isbn13 = isbn13From(info)
    const publishedYear = extractPublishedYear(info.publishedDate)
    const languageValue = nonEmptyString(info.language)?.toLocaleLowerCase()
    const language =
      languageValue !== undefined && isLanguageCode(languageValue) ? languageValue : undefined
    const publisher = nonEmptyString(info.publisher)
    const pageCount = positivePageCount(info.pageCount)
    const coverUrl = coverUrlFrom(info)
    const description = plainTextDescription(info.description)

    return {
      id: `${this.source}:${externalId}`,
      kind: 'EDITION',
      sources: [this.source],
      title,
      externalId,
      ...(authors === undefined ? {} : { authors }),
      ...(isbn13 === undefined ? {} : { isbn13 }),
      ...(language === undefined ? {} : { language }),
      ...(publishedYear === undefined ? {} : { publishedYear }),
      ...(publisher === undefined ? {} : { publisher }),
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(coverUrl === undefined ? {} : { coverUrl }),
      ...(description === undefined ? {} : { description }),
    }
  }
}
