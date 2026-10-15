import { Injectable } from '@nestjs/common'
import type { ExternalSearchResult } from '@bookswap/shared'
import { BookLookupProviderError } from '../../lookup/book-lookup-provider'
import { lookupUserAgentHeaders } from '../../lookup/lookup.config'
import {
  OPEN_LIBRARY_SEARCH_API_ROOT,
  OPEN_LIBRARY_SEARCH_FIELDS,
  openLibraryWorkRecord,
} from './open-library-search-provider'

/**
 * One external WORK record by its id — the confirmed metadata for quick-add of a work without a specific
 * edition (BS-114, docs/plan/fast-book-add.md, §13).
 *
 * A port of its own, like `EXTERNAL_VOLUME_PROVIDER`: tests replace this token with a fake (no real
 * HTTP, §11).
 */
export interface ExternalWorkProvider {
  /** `undefined` — the source has no such work. */
  fetchWork(workId: string, signal: AbortSignal): Promise<ExternalSearchResult | undefined>
}

export const EXTERNAL_WORK_PROVIDER = Symbol('EXTERNAL_WORK_PROVIDER')

/**
 * The same `search.json` and the same fields as the title search, narrowed to one `key`: the answer is
 * mapped by `openLibraryWorkRecord`, so the stored title, authors, first publication year and cover are
 * exactly what the card showed. `/works/OL…W.json` would name authors only by key — one more request per
 * author.
 *
 * Not behind `ProviderRateLimiter`, like `fetchVolume`: an explicit add must not queue behind suggestions.
 */
@Injectable()
export class OpenLibraryWorkProvider implements ExternalWorkProvider {
  async fetchWork(workId: string, signal: AbortSignal): Promise<ExternalSearchResult | undefined> {
    const url = new URL(OPEN_LIBRARY_SEARCH_API_ROOT)
    // `workId` passed the contract's `OL…W` pattern, so it cannot carry a quote into the query.
    url.searchParams.set('q', `key:"/works/${workId}"`)
    url.searchParams.set('fields', OPEN_LIBRARY_SEARCH_FIELDS)
    url.searchParams.set('limit', '1')

    let response: Response

    try {
      response = await fetch(url, { signal, headers: lookupUserAgentHeaders() })
    } catch (error) {
      throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
    }

    if (!response.ok) {
      throw new BookLookupProviderError(`Open Library відповів HTTP ${String(response.status)}`)
    }

    const body: unknown = await response.json().catch(() => undefined)

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BookLookupProviderError('Open Library повернув тіло, що не є JSON-об’єктом')
    }

    const documents = (body as Record<string, unknown>).docs
    const record = Array.isArray(documents)
      ? documents.map(openLibraryWorkRecord).find((found) => found?.externalId === workId)
      : undefined

    return record
  }
}
