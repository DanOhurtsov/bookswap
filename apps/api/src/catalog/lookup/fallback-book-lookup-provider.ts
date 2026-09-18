import { Injectable, Logger } from '@nestjs/common'
import type { BookLookupResult, BookLookupSource } from '@bookswap/shared'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import { GoogleBooksLookupProvider } from './google-books-lookup-provider'
import { IsbnDbLookupProvider } from './isbndb-lookup-provider'
import { OpenLibraryLookupProvider } from './open-library-lookup-provider'

interface ProviderAttempt {
  label: string
  source: BookLookupSource
  provider: BookLookupProvider
}

/** Tries exact-ISBN providers in priority order and tolerates an individual outage. */
@Injectable()
export class FallbackBookLookupProvider implements BookLookupProvider {
  private readonly logger = new Logger(FallbackBookLookupProvider.name)

  constructor(
    private readonly openLibrary: OpenLibraryLookupProvider,
    private readonly googleBooks: GoogleBooksLookupProvider,
    private readonly isbnDb: IsbnDbLookupProvider,
  ) {}

  async lookup(isbn: string, signal: AbortSignal): Promise<BookLookupResult | undefined> {
    const attempts: ProviderAttempt[] = [
      { label: 'Open Library', source: 'OPEN_LIBRARY', provider: this.openLibrary },
      { label: 'Google Books', source: 'GOOGLE_BOOKS', provider: this.googleBooks },
      { label: 'ISBNdb', source: 'ISBNDB', provider: this.isbnDb },
    ]
    const failures: string[] = []

    for (const attempt of attempts) {
      if (signal.aborted) break

      try {
        const result = await attempt.provider.lookup(isbn, signal)
        if (result !== undefined) {
          const withSource: BookLookupResult = { ...result, source: attempt.source }
          if (result.workExternalId !== undefined) return withSource

          try {
            const workExternalId = await this.openLibrary.lookupWork(
              result.title,
              result.authors ?? [],
              signal,
            )
            return workExternalId === undefined ? withSource : { ...withSource, workExternalId }
          } catch (error) {
            const description = error instanceof Error ? error.message : String(error)
            this.logger.warn(`Open Library Work enrichment failed: ${description}`)
            return withSource
          }
        }
      } catch (error) {
        const description = error instanceof Error ? error.message : String(error)
        failures.push(`${attempt.label}: ${description}`)
        this.logger.warn(`ISBN lookup ${attempt.label} failed: ${description}`)
      }
    }

    if (failures.length > 0) {
      throw new BookLookupProviderError(failures.join('; '))
    }

    return undefined
  }
}
