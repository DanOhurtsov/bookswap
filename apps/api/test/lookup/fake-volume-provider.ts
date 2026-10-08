import { BookLookupProviderError } from '../../src/catalog/lookup/book-lookup-provider'
import type { GoogleVolumeRecord } from '../../src/catalog/lookup/google-books-lookup-provider'
import type { ExternalVolumeProvider } from '../../src/catalog/lookup/google-books-volume-provider'

type Outcome =
  | { kind: 'found'; record: GoogleVolumeRecord }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'hang' }

/**
 * §11: жодного реального HTTP. Підміняє `EXTERNAL_VOLUME_PROVIDER` (том Google Books за id).
 *
 * `calls` — що саме питали в джерела: доводить, що відоме локально видання не торкається мережі.
 * `gate` — затримує відповідь, поки тест не дозволить: так змагання двох користувачів за один новий ISBN
 * відтворюється детерміновано (обидва вже отримали метадані, жоден ще не почав транзакцію).
 */
export class FakeVolumeProvider implements ExternalVolumeProvider {
  private readonly outcomes = new Map<string, Outcome>()
  readonly calls: string[] = []
  private gateReleased: Promise<void> | undefined

  respondWith(volumeId: string, record: GoogleVolumeRecord): void {
    this.outcomes.set(volumeId, { kind: 'found', record })
  }

  respondNotFound(volumeId: string): void {
    this.outcomes.set(volumeId, { kind: 'not-found' })
  }

  respondWithError(volumeId: string, message = 'провайдер зламався'): void {
    this.outcomes.set(volumeId, { kind: 'error', message })
  }

  hang(volumeId: string): void {
    this.outcomes.set(volumeId, { kind: 'hang' })
  }

  /** Повертає функцію, що відпускає всі відповіді, затримані цим гейтом. */
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

  async fetchVolume(
    volumeId: string,
    signal: AbortSignal,
  ): Promise<GoogleVolumeRecord | undefined> {
    this.calls.push(volumeId)

    const gate = this.gateReleased

    if (gate !== undefined) await gate

    const outcome = this.outcomes.get(volumeId)

    if (outcome === undefined || outcome.kind === 'not-found') return undefined
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
