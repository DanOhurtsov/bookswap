import { Injectable, Logger } from '@nestjs/common'
import type { BookLookupResult, BookLookupSource } from '@bookswap/shared'
import { externalSearchTimeoutMs } from '../search/external/external-search.config'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import { GoogleBooksLookupProvider } from './google-books-lookup-provider'
import { runWithTimeout } from './lookup-timeout'
import { OpenLibraryLookupProvider } from './open-library-lookup-provider'

interface ProviderAttempt {
  label: string
  source: BookLookupSource
  provider: BookLookupProvider
}

/**
 * Asks every exact-ISBN source at once and returns ONE merged record.
 *
 * Open Library and Google Books are queried in parallel, each under its own
 * deadline, so a slow source neither blocks the other nor turns an answer we
 * already hold into a timeout. The record of the higher-priority source stays
 * the basis and the other one only fills fields it LACKS — a disagreement is
 * never settled by overwriting.
 *
 * ISBNdb is deliberately not asked here: it is paid and quota-limited, and the
 * agreed scope is the two free sources. It is still used by the batch path
 * (`BatchedBookLookupProvider`).
 *
 * Any source answering is enough. A failure only surfaces when NOTHING was
 * found: "a source did not answer" must not become "no such book".
 */
@Injectable()
export class FallbackBookLookupProvider implements BookLookupProvider {
  private readonly logger = new Logger(FallbackBookLookupProvider.name)

  constructor(
    private readonly openLibrary: OpenLibraryLookupProvider,
    private readonly googleBooks: GoogleBooksLookupProvider,
  ) {}

  async lookup(isbn: string, signal: AbortSignal): Promise<BookLookupResult | undefined> {
    // Priority order: the first record is the basis of the merge.
    const attempts: ProviderAttempt[] = [
      { label: 'Open Library', source: 'OPEN_LIBRARY', provider: this.openLibrary },
      { label: 'Google Books', source: 'GOOGLE_BOOKS', provider: this.googleBooks },
    ]

    const outcomes = await Promise.all(
      attempts.map(async (attempt) => this.ask(attempt, isbn, signal)),
    )

    const failures = outcomes.flatMap((outcome) => (outcome.kind === 'failed' ? [outcome] : []))
    const found = outcomes.flatMap((outcome) => (outcome.kind === 'found' ? [outcome.result] : []))

    const [basis, ...rest] = found

    if (basis === undefined) {
      if (failures.length > 0) {
        throw new BookLookupProviderError(
          failures.map((failure) => `${failure.label}: ${failure.description}`).join('; '),
        )
      }

      return undefined
    }

    const merged = rest.reduce(mergeLookupResults, basis)

    if (merged.workExternalId !== undefined) return merged

    try {
      const workExternalId = await this.openLibrary.lookupWork(
        merged.title,
        merged.authors ?? [],
        signal,
      )

      return workExternalId === undefined ? merged : { ...merged, workExternalId }
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Open Library Work enrichment failed: ${description}`)
      return merged
    }
  }

  /** One source under its own deadline; a failure is recorded, never thrown. */
  private async ask(
    attempt: ProviderAttempt,
    isbn: string,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const outcome = await runWithTimeout(
      externalSearchTimeoutMs(),
      async (inner) => attempt.provider.lookup(isbn, inner),
      signal,
    )

    if (outcome.kind === 'value') {
      return outcome.value === undefined
        ? { kind: 'missing' }
        : { kind: 'found', result: { ...outcome.value, source: attempt.source } }
    }

    const description =
      outcome.kind === 'timeout'
        ? 'deadline exceeded'
        : outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error)

    this.logger.warn(`ISBN lookup ${attempt.label} failed: ${description}`)

    return { kind: 'failed', label: attempt.label, description }
  }
}

type AttemptOutcome =
  | { kind: 'found'; result: BookLookupResult }
  | { kind: 'missing' }
  | { kind: 'failed'; label: string; description: string }

/**
 * `base` stays the basis and only the fields it lacks come from `extra`.
 *
 * `source` and `externalId` describe WHICH record this is, so they are never
 * borrowed: an `externalId` taken from Google Books under `source: OPEN_LIBRARY`
 * would point at a record that source does not have. `workExternalId` is an
 * Open Library reference by definition and is filled like any other gap.
 */
function mergeLookupResults(base: BookLookupResult, extra: BookLookupResult): BookLookupResult {
  const merged: BookLookupResult = { ...base }

  for (const [key, value] of Object.entries(extra)) {
    if (key === 'source' || key === 'externalId') continue

    if (value !== undefined && merged[key as keyof BookLookupResult] === undefined) {
      Object.assign(merged, { [key]: value })
    }
  }

  return merged
}
