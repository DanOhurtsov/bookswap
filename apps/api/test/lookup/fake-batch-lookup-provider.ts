import type { BookLookupResult } from '@bookswap/shared'
import type {
  BatchBookLookupOutcome,
  BatchBookLookupProvider,
  BatchLookupUnavailableReason,
} from '../../src/catalog/lookup/batch-book-lookup-provider'

type Outcome =
  | { kind: 'found'; result: BookLookupResult }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; reason: BatchLookupUnavailableReason }

/**
 * §11: no real HTTP in tests. Replaces `BATCH_BOOK_LOOKUP_PROVIDER` through
 * `overrideProvider`, so the service, the resolver and the cache are the real
 * ones and only the network is faked.
 *
 * `batches` is the point of the class as much as the answers are: it is how a
 * test proves that 200 rows went out as a handful of calls rather than 200, and
 * that a cache hit cost no call at all.
 */
/** A call parked inside the provider, and the switch that lets it out. */
export interface ProviderGate {
  /** Resolves once the provider has actually been asked about the ISBN. */
  entered: Promise<void>
  release: () => void
}

export class FakeBatchLookupProvider implements BatchBookLookupProvider {
  private readonly outcomes = new Map<string, Outcome>()
  private readonly gates = new Map<string, { enter: () => void; released: Promise<void> }>()
  /** Every call, with the exact ISBNs it was asked for. */
  readonly batches: string[][] = []

  /**
   * Parks the NEXT call that asks about this ISBN until `release()` is called.
   *
   * One-shot on purpose: the operation racing against the parked one usually
   * asks about the same ISBN, and a gate that held every call would deadlock
   * the very race it exists to stage.
   *
   * This is how the race tests stay deterministic: no sleeps and no guessing
   * how long a request takes — the test knows the operation is inside the
   * provider because the provider said so, and decides itself when it returns.
   */
  hold(isbn: string): ProviderGate {
    let enter = (): void => undefined
    let release = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })

    this.gates.set(isbn, { enter, released })

    return { entered, release }
  }

  respondWith(isbn: string, result: BookLookupResult): void {
    this.outcomes.set(isbn, { kind: 'found', result })
  }

  respondNotFound(isbn: string): void {
    this.outcomes.set(isbn, { kind: 'not-found' })
  }

  respondUnavailable(isbn: string, reason: BatchLookupUnavailableReason = 'PROVIDER_ERROR'): void {
    this.outcomes.set(isbn, { kind: 'unavailable', reason })
  }

  async lookupMany(isbns: readonly string[]): Promise<BatchBookLookupOutcome> {
    this.batches.push([...isbns])

    for (const isbn of isbns) {
      const gate = this.gates.get(isbn)

      if (gate === undefined) continue

      this.gates.delete(isbn)
      gate.enter()
      await gate.released
    }

    const outcome: BatchBookLookupOutcome = {
      found: new Map(),
      notFound: new Set(),
      unavailable: new Map(),
    }

    for (const isbn of isbns) {
      const configured = this.outcomes.get(isbn) ?? { kind: 'not-found' as const }

      if (configured.kind === 'found') outcome.found.set(isbn, configured.result)
      if (configured.kind === 'not-found') outcome.notFound.add(isbn)
      if (configured.kind === 'unavailable') outcome.unavailable.set(isbn, configured.reason)
    }

    return outcome
  }

  /** How many ISBNs were asked about in total — the external-call budget of a test. */
  get askedCount(): number {
    return this.batches.reduce((sum, batch) => sum + batch.length, 0)
  }

  clear(): void {
    this.outcomes.clear()
    this.gates.clear()
    this.batches.length = 0
  }
}
