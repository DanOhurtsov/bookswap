import { Injectable } from '@nestjs/common'
import { relevanceOf, type ExternalSearchResult } from '@bookswap/shared'
import { lookupUserAgentHeaders } from '../../lookup/lookup.config'
import { nonEmptyString, stringArray } from '../../lookup/lookup-provider.utils'
import { iso6391FromMarc } from '../../lookup/marc-language'
import {
  ExternalSearchProviderError,
  type ExternalSearchContext,
  type ExternalSearchProvider,
} from './external-search-provider'
import { searchTerms } from './search-terms'

const SEARCH_API_ROOT = 'https://openlibrary.org/search.json'

/**
 * Exactly the fields we actually read.
 *
 * `fields` is narrowed deliberately: the documentation asks not to pull `*`
 * without need, because a full answer is expensive for the provider. `isbn` is
 * NOT among them — see `toResult`.
 */
const FIELDS = 'key,title,author_name,first_publish_year,language,cover_i'

/** `cover_i` → URL. `M` is the medium size, the one Open Library itself shows. */
function coverUrlFrom(coverId: unknown): string | undefined {
  if (typeof coverId !== 'number' || !Number.isInteger(coverId) || coverId <= 0) return undefined

  return `https://covers.openlibrary.org/b/id/${String(coverId)}-M.jpg`
}

/** `/works/OL123W` → `OL123W`; anything else → `undefined`. */
function workIdFromKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/works\/OL[0-9]+W$/u.test(value)) return undefined

  return value.slice('/works/'.length)
}

/**
 * The work's language — only when it is unambiguous.
 *
 * `language` in a `search.json` document is the set of languages of ALL known
 * editions of the work. If there are several, none of them is "the language of
 * this book": picking the first would report the language of a random foreign
 * printing. A single element is different — then the work has no other language.
 */
function unambiguousLanguage(languages: unknown): string | undefined {
  if (!Array.isArray(languages) || languages.length !== 1) return undefined

  return iso6391FromMarc(languages[0])
}

/**
 * The Solr query: every term must appear in the title OR among the authors.
 *
 * `search.json` is a Solr index and takes that structure directly, which is why
 * Open Library needs only ONE request for all three shapes of query — title
 * only, author only, and mixed ("Тигролови Багряний"). Each term is its own
 * bracketed OR, and the brackets are ANDed:
 *
 *     (title:"Тигролови" OR author:"Тигролови") AND (title:"Багряний" OR author:"Багряний")
 *
 * Two things this deliberately does NOT do. It does not send the query as free
 * text — bare `q=` searches the work's full text, subjects and description, and
 * that is what returned lesson plans for a novel's name. And it does not put
 * the whole mixed query into `title:`, which would demand a book actually
 * called "Тигролови Багряний" and find nothing: `title:(a b)` is an AND of
 * terms inside one field, as the provider's own behaviour confirms.
 *
 * Quoting is safe without escaping because `searchTerms` has already dropped
 * every character that is not a letter or a digit, so no term can carry a
 * quote, colon, parenthesis or backslash into the query language.
 */
function crossFieldQuery(terms: readonly string[]): string {
  return terms.map((term) => `(title:"${term}" OR author:"${term}")`).join(' AND ')
}

/**
 * Title search through the Open Library Search API.
 *
 * Every document is a `WORK`, not an edition, and everything else follows from
 * that. `search.json` indexes works: its `isbn` is the union of every known
 * printing's ISBNs, `publisher` of every publisher, `language` of every
 * language. None of those describes the book in a person's hands, so no ISBN is
 * taken from here at all (`fields` does not even request it), and the language
 * only when the list holds exactly one. The year here is `first_publish_year`,
 * the WORK's first publication year (`Work.firstPubYear`), which is
 * fundamentally not the printing year (`Edition.year`); the contract keeps them
 * as separate fields.
 *
 * The query is field-restricted — see `crossFieldQuery`. Nothing here ever
 * falls back to a bare `q=`: an unrestricted answer is not a narrower answer,
 * it is the wrong one.
 *
 * A `User-Agent` carrying a contact is the provider's requirement
 * (https://openlibrary.org/developers/api): unidentified clients are documented
 * at 1 request/s, identified ones at 3. The header is built by the same
 * `lookupUserAgentHeaders()` as the ISBN lookup, so the contact
 * (`CATALOG_LOOKUP_CONTACT`) is configured in one place.
 */
@Injectable()
export class OpenLibrarySearchProvider implements ExternalSearchProvider {
  readonly source = 'OPEN_LIBRARY' as const

  async search(
    query: string,
    limit: number,
    context: ExternalSearchContext,
  ): Promise<ExternalSearchResult[]> {
    const terms = searchTerms(query)

    // No terms at all means the query was pure punctuation. There is nothing to
    // restrict the search to, and asking with an empty query would be the
    // unrestricted search this provider must not perform.
    if (terms.length === 0) return []

    const url = new URL(SEARCH_API_ROOT)
    url.searchParams.set('q', crossFieldQuery(terms))
    url.searchParams.set('fields', FIELDS)
    url.searchParams.set('limit', String(limit))

    await context.acquire()

    let response: Response

    try {
      response = await fetch(url, { signal: context.signal, headers: lookupUserAgentHeaders() })
    } catch (error) {
      throw new ExternalSearchProviderError(
        error instanceof Error ? error.message : 'мережева помилка',
      )
    }

    if (!response.ok) {
      throw new ExternalSearchProviderError(
        `Open Library search відповів HTTP ${String(response.status)}`,
      )
    }

    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ExternalSearchProviderError('Open Library search повернув не JSON-об’єкт')
    }

    const documents = (body as Record<string, unknown>).docs

    // Empty results arrive as `docs: []`; a missing `docs` likewise means
    // "nothing", not a reason to fail the whole search.
    if (!Array.isArray(documents)) return []

    return (
      documents
        .map((document) => this.toResult(document))
        .filter((result): result is ExternalSearchResult => result !== undefined)
        // The gate, even though the query was field-restricted: Solr matches
        // stemmed and transliterated forms, so a document can come back whose
        // title and authors say none of what was asked.
        .filter((result) => relevanceOf(query, result).matched)
        .slice(0, limit)
    )
  }

  /** A document with no title, or no recognizable `/works/OL…W`, is skipped. */
  private toResult(value: unknown): ExternalSearchResult | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

    const document = value as Record<string, unknown>
    const workExternalId = workIdFromKey(document.key)
    const title = nonEmptyString(document.title)

    if (workExternalId === undefined || title === undefined) return undefined

    const authors = stringArray(document.author_name)
    const language = unambiguousLanguage(document.language)
    const coverUrl = coverUrlFrom(document.cover_i)
    const firstPublished = document.first_publish_year
    const firstPublishedYear =
      typeof firstPublished === 'number' && Number.isInteger(firstPublished)
        ? firstPublished
        : undefined

    return {
      id: `${this.source}:${workExternalId}`,
      kind: 'WORK',
      sources: [this.source],
      title,
      externalId: workExternalId,
      workExternalId,
      ...(authors === undefined ? {} : { authors }),
      ...(language === undefined ? {} : { language }),
      ...(firstPublishedYear === undefined ? {} : { firstPublishedYear }),
      ...(coverUrl === undefined ? {} : { coverUrl }),
    }
  }
}
