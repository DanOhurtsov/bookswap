import { Injectable } from '@nestjs/common'
import { BookLookupProviderError } from './book-lookup-provider'
import {
  GOOGLE_BOOKS_API_ROOT,
  asRecord,
  toRecord,
  type GoogleVolumeRecord,
} from './google-books-lookup-provider'

/**
 * Один том за його id — точне джерело метаданих для швидкого додавання зовнішнього видання
 * (docs/plan/fast-book-add.md, §5.3).
 *
 * Окремий порт, а не метод `BookLookupProvider`: пошук за ISBN і вибірка за id — різні питання, а тести
 * підміняють цей токен фейком (жодного реального HTTP, §11).
 */
export interface ExternalVolumeProvider {
  /** `undefined` — такого тому немає (HTTP 404). */
  fetchVolume(volumeId: string, signal: AbortSignal): Promise<GoogleVolumeRecord | undefined>
}

export const EXTERNAL_VOLUME_PROVIDER = Symbol('EXTERNAL_VOLUME_PROVIDER')

@Injectable()
export class GoogleBooksVolumeProvider implements ExternalVolumeProvider {
  async fetchVolume(
    volumeId: string,
    signal: AbortSignal,
  ): Promise<GoogleVolumeRecord | undefined> {
    const url = new URL(`${GOOGLE_BOOKS_API_ROOT}/${encodeURIComponent(volumeId)}`)
    url.searchParams.set('projection', 'full')

    const apiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim()
    if (apiKey !== undefined && apiKey !== '') url.searchParams.set('key', apiKey)

    let response: Response

    try {
      response = await fetch(url, { signal })
    } catch (error) {
      throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
    }

    if (response.status === 404) return undefined

    if (!response.ok) {
      throw new BookLookupProviderError(`Google Books відповів HTTP ${String(response.status)}`)
    }

    const body = asRecord(await response.json().catch(() => undefined))

    if (body === undefined) {
      throw new BookLookupProviderError('Google Books повернув тіло, що не є JSON-об’єктом')
    }

    return toRecord(body)
  }
}
