import { Injectable } from '@nestjs/common'
import { isLanguageCode, isValidIsbn13, type BookLookupResult } from '@bookswap/shared'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import {
  exactIsbn13,
  extractPublishedYear,
  nonEmptyString,
  normalizedCoverUrl,
  plainTextDescription,
  positivePageCount,
  stringArray,
} from './lookup-provider.utils'

export const GOOGLE_BOOKS_API_ROOT = 'https://www.googleapis.com/books/v1/volumes'

export interface GoogleVolume {
  id?: unknown
  volumeInfo?: unknown
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasExactIsbn(volume: GoogleVolume, isbn: string): boolean {
  const info = asRecord(volume.volumeInfo)
  if (info === undefined || !Array.isArray(info.industryIdentifiers)) return false

  return info.industryIdentifiers.some((identifier) => {
    const record = asRecord(identifier)
    return record !== undefined && exactIsbn13(record.identifier, isbn)
  })
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

/** Томи й їхні `industryIdentifiers`: перший валідний ISBN-13, якщо він є. */
function isbn13Of(info: Record<string, unknown>): string | undefined {
  if (!Array.isArray(info.industryIdentifiers)) return undefined

  for (const identifier of info.industryIdentifiers) {
    const record = asRecord(identifier)

    if (record === undefined || record.type !== 'ISBN_13') continue

    const value = nonEmptyString(record.identifier)?.replaceAll(/[-\s]/g, '')

    if (value !== undefined && isValidIsbn13(value)) return value
  }

  return undefined
}

/** Один том, розібраний у нашу форму. `isbn13` — ISBN самого видання, якщо джерело його повідомило. */
export interface GoogleVolumeRecord {
  result: BookLookupResult
  isbn13?: string
  externalId: string
}

/** Том Google Books → наша форма. Назва обов'язкова: без неї запису немає. */
export function toRecord(volume: GoogleVolume): GoogleVolumeRecord {
  const info = asRecord(volume.volumeInfo)
  const title = nonEmptyString(info?.title)

  if (info === undefined || title === undefined) {
    throw new BookLookupProviderError('Google Books повернув том без назви')
  }

  const authors = stringArray(info.authors)
  const publishedYear = extractPublishedYear(info.publishedDate)
  const languageValue = nonEmptyString(info.language)?.toLocaleLowerCase()
  const language =
    languageValue !== undefined && isLanguageCode(languageValue) ? languageValue : undefined
  const publisher = nonEmptyString(info.publisher)
  const description = plainTextDescription(info.description)
  const pageCount = positivePageCount(info.pageCount)
  const coverUrl = coverUrlFrom(info)
  const externalId = nonEmptyString(volume.id)
  const isbn13 = isbn13Of(info)

  if (externalId === undefined)
    throw new BookLookupProviderError('Google Books повернув том без id')

  return {
    externalId,
    ...(isbn13 === undefined ? {} : { isbn13 }),
    result: {
      title,
      ...(authors === undefined ? {} : { authors }),
      ...(publishedYear === undefined ? {} : { publishedYear }),
      ...(language === undefined ? {} : { language }),
      ...(publisher === undefined ? {} : { publisher }),
      ...(description === undefined ? {} : { description }),
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(coverUrl === undefined ? {} : { coverUrl }),
      externalId,
    },
  }
}

/** Exact-ISBN fallback backed by the public Google Books Volumes API. */
@Injectable()
export class GoogleBooksLookupProvider implements BookLookupProvider {
  async lookup(isbn: string, signal: AbortSignal): Promise<BookLookupResult | undefined> {
    const url = new URL(GOOGLE_BOOKS_API_ROOT)
    url.searchParams.set('q', `isbn:${isbn}`)
    url.searchParams.set('maxResults', '10')
    url.searchParams.set('projection', 'full')

    const apiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim()
    if (apiKey !== undefined && apiKey !== '') url.searchParams.set('key', apiKey)

    let response: Response

    try {
      response = await fetch(url, { signal })
    } catch (error) {
      throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
    }

    if (!response.ok) {
      throw new BookLookupProviderError(`Google Books відповів HTTP ${String(response.status)}`)
    }

    const body = asRecord(await response.json().catch(() => undefined))
    if (body === undefined) {
      throw new BookLookupProviderError('Google Books повернув тіло, що не є JSON-об’єктом')
    }

    if (!Array.isArray(body.items)) return undefined

    const volume = body.items
      .map((item) => asRecord(item) as GoogleVolume | undefined)
      .find((item): item is GoogleVolume => item !== undefined && hasExactIsbn(item, isbn))

    if (volume === undefined) return undefined

    const info = asRecord(volume.volumeInfo)
    const title = nonEmptyString(info?.title)
    if (info === undefined || title === undefined) {
      throw new BookLookupProviderError('Google Books повернув точний ISBN без назви')
    }

    // Той самий розбір тому, що й у `fetchVolume`; для пошуку за ISBN `id` тому не обов'язковий.
    const externalId = nonEmptyString(volume.id)
    const { result } = toRecord({ ...volume, id: externalId ?? 'без-id' })

    return externalId === undefined ? omitExternalId(result) : result
  }
}

function omitExternalId(result: BookLookupResult): BookLookupResult {
  const { externalId: _externalId, ...rest } = result

  void _externalId

  return rest
}
