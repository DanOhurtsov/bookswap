import type { ExternalSearchResult } from '@bookswap/shared'
import { BookLookupProviderError } from '../../src/catalog/lookup/book-lookup-provider'
import type { ExternalWorkProvider } from '../../src/catalog/search/external/open-library-work-provider'

type Outcome =
  | { kind: 'found'; record: ExternalSearchResult }
  | { kind: 'error'; message: string }
  | { kind: 'hang' }

/**
 * §11: no real HTTP. Replaces `EXTERNAL_WORK_PROVIDER` (one Open Library work by its `OL…W`).
 *
 * `calls` — what the source was asked: proves that a known record never touches the network. `holdResponses`
 * — holds every answer until the test lets go, so two first adds of one record race deterministically.
 */
export class FakeWorkProvider implements ExternalWorkProvider {
  private readonly outcomes = new Map<string, Outcome>()
  readonly calls: string[] = []
  private gateReleased: Promise<void> | undefined

  respondWith(record: ExternalSearchResult): void {
    if (record.externalId === undefined) throw new Error('Запис твору без externalId')

    this.outcomes.set(record.externalId, { kind: 'found', record })
  }

  respondWithError(workId: string, message = 'провайдер зламався'): void {
    this.outcomes.set(workId, { kind: 'error', message })
  }

  hang(workId: string): void {
    this.outcomes.set(workId, { kind: 'hang' })
  }

  holdResponses(): () => void {
    let release!: () => void

    this.gateReleased = new Promise<void>((resolve) => {
      release = resolve
    })

    return () => {
      release()
      this.gateReleased = undefined
    }
  }

  async fetchWork(workId: string, signal: AbortSignal): Promise<ExternalSearchResult | undefined> {
    this.calls.push(workId)

    const gate = this.gateReleased

    if (gate !== undefined) await gate

    const outcome = this.outcomes.get(workId)

    if (outcome === undefined) return undefined
    if (outcome.kind === 'found') return outcome.record
    if (outcome.kind === 'error') throw new BookLookupProviderError(outcome.message)

    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
    })
  }

  clear(): void {
    this.outcomes.clear()
    this.calls.length = 0
    this.gateReleased = undefined
  }
}
