import { Injectable, Logger } from '@nestjs/common'
import {
  type BatchBookLookupOutcome,
  type BatchBookLookupProvider,
  type BatchLookupUnavailableReason,
} from './batch-book-lookup-provider'
import type { BookLookupProvider } from './book-lookup-provider'
import { GoogleBooksLookupProvider } from './google-books-lookup-provider'
import { IsbnDbLookupProvider } from './isbndb-lookup-provider'
import { runWithTimeout } from './lookup-timeout'
import { lookupFallbackBudget, lookupFallbackConcurrency, lookupTimeoutMs } from './lookup.config'
import {
  OPEN_LIBRARY_BIBKEYS_PER_REQUEST,
  OpenLibraryLookupProvider,
} from './open-library-lookup-provider'

/**
 * Stage 8f-2, R7 + agreed R7a: Open Library in batches, then a bounded number of
 * single-ISBN fallbacks.
 *
 * Deliberately NOT built on `FallbackBookLookupProvider`. That wrapper is
 * right for one book at a time and wrong here twice over: it would ask Open
 * Library again for ISBNs the batch already covered, and it runs a second
 * Open Library search per result to enrich `workExternalId` — a hidden N+1 that
 * a 200-row file would turn into hundreds of requests.
 *
 * The budget counts distinct ISBNs, not HTTP calls: two fallback providers can
 * mean up to twice as many requests for the same budget. ISBNs are spent in
 * first-occurrence order, so the same file always resolves the same rows.
 */
@Injectable()
export class BatchedBookLookupProvider implements BatchBookLookupProvider {
  private readonly logger = new Logger(BatchedBookLookupProvider.name)

  constructor(
    private readonly openLibrary: OpenLibraryLookupProvider,
    private readonly googleBooks: GoogleBooksLookupProvider,
    private readonly isbnDb: IsbnDbLookupProvider,
  ) {}

  async lookupMany(isbns: readonly string[], signal: AbortSignal): Promise<BatchBookLookupOutcome> {
    const outcome: BatchBookLookupOutcome = {
      found: new Map(),
      notFound: new Set(),
      unavailable: new Map(),
    }
    const pending = [...new Set(isbns)]

    if (pending.length === 0) return outcome

    const failed = await this.runOpenLibraryBatches(pending, outcome, signal)
    const remaining = pending.filter((isbn) => !outcome.found.has(isbn))

    await this.runBoundedFallback(remaining, failed, outcome, signal)

    return outcome
  }

  /**
   * Bibkeys go out in chunks of {@link OPEN_LIBRARY_BIBKEYS_PER_REQUEST},
   * sequentially: a 200-row file is four requests, not four hundred, and not
   * four at once either. A chunk that fails does not end the pass — its ISBNs
   * simply carry their failure reason into the fallback, where a later provider
   * may still answer them.
   */
  private async runOpenLibraryBatches(
    isbns: readonly string[],
    outcome: BatchBookLookupOutcome,
    signal: AbortSignal,
  ): Promise<Map<string, BatchLookupUnavailableReason>> {
    const failed = new Map<string, BatchLookupUnavailableReason>()

    for (let start = 0; start < isbns.length; start += OPEN_LIBRARY_BIBKEYS_PER_REQUEST) {
      const chunk = isbns.slice(start, start + OPEN_LIBRARY_BIBKEYS_PER_REQUEST)

      if (signal.aborted) {
        for (const isbn of chunk) failed.set(isbn, 'TIMEOUT')
        continue
      }

      const result = await runWithTimeout(
        lookupTimeoutMs(),
        (inner) => this.openLibrary.lookupMany(chunk, inner),
        signal,
      )

      if (result.kind === 'value') {
        for (const [isbn, book] of result.value.found) outcome.found.set(isbn, book)

        // A record we could not read is a failure about that ISBN alone: the
        // rest of the batch stands, and this one goes to the fallback carrying
        // its failure, so "nobody found it" cannot become "no such book".
        for (const [isbn, reason] of result.value.failed) {
          this.logFailure('Open Library record', new Error(reason))
          failed.set(isbn, 'PROVIDER_ERROR')
        }

        continue
      }

      const reason = result.kind === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR'

      if (result.kind === 'error') this.logFailure('Open Library batch', result.error)

      for (const isbn of chunk) failed.set(isbn, reason)
    }

    return failed
  }

  /**
   * Google Books, then ISBNdb, one ISBN at a time — the only shape those APIs
   * offer. `budget` distinct ISBNs, `concurrency` in flight; everything past the
   * budget is reported as `BUDGET_EXHAUSTED`, never as "not found", so the owner
   * can retry those rows instead of being told the books do not exist.
   */
  private async runBoundedFallback(
    isbns: readonly string[],
    failed: ReadonlyMap<string, BatchLookupUnavailableReason>,
    outcome: BatchBookLookupOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const budget = lookupFallbackBudget()
    const affordable = isbns.slice(0, budget)

    for (const isbn of isbns.slice(budget)) outcome.unavailable.set(isbn, 'BUDGET_EXHAUSTED')

    let next = 0
    const workers = Array.from(
      { length: Math.min(lookupFallbackConcurrency(), affordable.length) },
      async () => {
        while (next < affordable.length) {
          const isbn = affordable[next++]

          if (isbn === undefined) return

          await this.resolveOne(isbn, failed.get(isbn), outcome, signal)
        }
      },
    )

    await Promise.all(workers)
  }

  /** A later provider's success cancels an earlier one's failure — and its own failure never wins over a result. */
  private async resolveOne(
    isbn: string,
    carried: BatchLookupUnavailableReason | undefined,
    outcome: BatchBookLookupOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const attempts: { label: string; provider: BookLookupProvider }[] = [
      { label: 'Google Books', provider: this.googleBooks },
      { label: 'ISBNdb', provider: this.isbnDb },
    ]
    let unavailable: BatchLookupUnavailableReason | undefined = carried

    for (const attempt of attempts) {
      if (signal.aborted) {
        unavailable ??= 'TIMEOUT'
        break
      }

      const result = await runWithTimeout(
        lookupTimeoutMs(),
        (inner) => attempt.provider.lookup(isbn, inner),
        signal,
      )

      if (result.kind === 'value' && result.value !== undefined) {
        outcome.found.set(isbn, result.value)
        return
      }

      if (result.kind === 'timeout') unavailable = 'TIMEOUT'
      if (result.kind === 'error') {
        this.logFailure(`ISBN lookup ${attempt.label}`, result.error)
        unavailable ??= 'PROVIDER_ERROR'
      }
    }

    if (unavailable === undefined) {
      outcome.notFound.add(isbn)
    } else {
      outcome.unavailable.set(isbn, unavailable)
    }
  }

  /** Only the provider's own message — never an ISBN list, a row or file content. */
  private logFailure(label: string, error: unknown): void {
    this.logger.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
