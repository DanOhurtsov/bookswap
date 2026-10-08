import { useMemo, useSyncExternalStore } from 'react'

/**
 * Test stand-in for Next's address handling. Next patches `history.pushState` and `replaceState`
 * so that `useSearchParams` follows them; jsdom does not, so a spec that renders the library screen
 * installs `watchHistory()` and mocks `useSearchParams` with `useAddressSearchParams`.
 */
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)

  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function useAddressSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => '',
  )

  return useMemo(() => new URLSearchParams(search), [search])
}

/** Makes `pushState` and `replaceState` tell the subscribers. Returns the function that undoes it. */
export function watchHistory(): () => void {
  const { pushState, replaceState } = window.history
  const push = pushState.bind(window.history)
  const replace = replaceState.bind(window.history)

  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    push(...args)
    notify()
  }
  window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
    replace(...args)
    notify()
  }

  return () => {
    window.history.pushState = pushState
    window.history.replaceState = replaceState
  }
}

/** Puts the page at `/library` plus `search` (e.g. `?view=archive`), without adding a history entry. */
export function setAddress(search = ''): void {
  window.history.replaceState(null, '', `/library${search}`)
}
