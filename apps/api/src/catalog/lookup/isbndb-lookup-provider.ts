import { Injectable } from '@nestjs/common'
import { isLanguageCode, type BookLookupResult } from '@bookswap/shared'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import {
  editionFormatFromBinding,
  exactIsbn13,
  extractPublishedYear,
  nonEmptyString,
  normalizedCoverUrl,
  plainTextDescription,
  positivePageCount,
  stringArray,
} from './lookup-provider.utils'

const DEFAULT_API_ROOT = 'https://api2.isbndb.com'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Optional paid fallback. It stays disabled until ISBNDB_API_KEY is configured. */
@Injectable()
export class IsbnDbLookupProvider implements BookLookupProvider {
  async lookup(isbn: string, signal: AbortSignal): Promise<BookLookupResult | undefined> {
    const apiKey = process.env.ISBNDB_API_KEY?.trim()
    if (apiKey === undefined || apiKey === '') return undefined

    const configuredRoot = process.env.ISBNDB_API_URL?.trim()
    const apiRoot =
      configuredRoot === undefined || configuredRoot === ''
        ? DEFAULT_API_ROOT
        : configuredRoot.replace(/\/$/u, '')

    let response: Response

    try {
      response = await fetch(`${apiRoot}/book/${encodeURIComponent(isbn)}`, {
        signal,
        headers: { Accept: 'application/json', 'x-api-key': apiKey },
      })
    } catch (error) {
      throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
    }

    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new BookLookupProviderError(`ISBNdb відповів HTTP ${String(response.status)}`)
    }

    const body = asRecord(await response.json().catch(() => undefined))
    const book = asRecord(body?.book)
    if (body === undefined || book === undefined) {
      throw new BookLookupProviderError('ISBNdb повернув тіло без об’єкта book')
    }

    if (!exactIsbn13(book.isbn13, isbn)) return undefined

    const title = nonEmptyString(book.title)
    if (title === undefined) {
      throw new BookLookupProviderError('ISBNdb повернув точний ISBN без назви')
    }

    const authors = stringArray(book.authors)
    const publishedYear = extractPublishedYear(book.date_published)
    const languageValue = nonEmptyString(book.language)?.toLocaleLowerCase()
    const language =
      languageValue !== undefined && isLanguageCode(languageValue) ? languageValue : undefined
    const publisher = nonEmptyString(book.publisher)
    const description = plainTextDescription(book.synopsis ?? book.overview)
    const pageCount = positivePageCount(book.pages)
    const format = editionFormatFromBinding(book.binding)
    const coverUrl = normalizedCoverUrl(book.image_original ?? book.image)

    return {
      title,
      ...(authors === undefined ? {} : { authors }),
      ...(publishedYear === undefined ? {} : { publishedYear }),
      ...(language === undefined ? {} : { language }),
      ...(publisher === undefined ? {} : { publisher }),
      ...(description === undefined ? {} : { description }),
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(format === undefined ? {} : { format }),
      ...(coverUrl === undefined ? {} : { coverUrl }),
    }
  }
}
