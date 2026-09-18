/**
 * Bounds one provider call in wall-clock time, whatever the provider does with
 * the `AbortSignal` it is handed.
 *
 * The guarantee is the race, not the signal: a provider that ignores
 * cancellation still cannot hold the caller past the deadline. The signal is
 * passed on anyway so a real HTTP provider can drop a request nobody is waiting
 * for any more — the same division of labour as `LookupService.fetchFromProvider`.
 */
export type TimedOutcome<T> =
  { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error'; error: unknown }

class TimeoutMarker extends Error {}

export async function runWithTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<TimedOutcome<T>> {
  const controller = new AbortController()
  const abortOuter = (): void => {
    controller.abort()
  }

  outer?.addEventListener('abort', abortOuter)

  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting, exactly as the single-ISBN path does: a provider
      // that rejects synchronously on `abort` would otherwise win the race and
      // a timeout would be reported as a provider error.
      reject(new TimeoutMarker())
      controller.abort()
    }, timeoutMs)
  })

  const started = call(controller.signal)
  // A lost race must not leave an unhandled rejection behind.
  void started.catch(() => undefined)

  try {
    return { kind: 'value', value: await Promise.race([started, timeout]) }
  } catch (error) {
    return error instanceof TimeoutMarker ? { kind: 'timeout' } : { kind: 'error', error }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', abortOuter)
  }
}
