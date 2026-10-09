'use client'

import { useEffect } from 'react'

/**
 * Keeps legacy readers (`useFriends`, `useNotifications`) in step with a TanStack mutation.
 *
 * The legacy hooks have no shared cache, so `invalidateQueries` never reaches them (CONVENTIONS
 * §3.9), and every mounted instance — the navbar badge, the notifications page, the friends page —
 * owns its own copy of the data. A mutation announces which resource it changed; every mounted
 * reader of that resource reloads itself. A window event, not a module-level emitter: nothing is
 * shared between server renders, and the same mechanism already carries theme changes.
 */
export type SyncedResource = 'friends' | 'notifications'

const RESOURCE_CHANGED_EVENT = 'bookswap:resource-changed'

export function announceResourceChanged(resource: SyncedResource): void {
  window.dispatchEvent(
    new CustomEvent<SyncedResource>(RESOURCE_CHANGED_EVENT, { detail: resource }),
  )
}

/** `reload` must be stable (both legacy hooks wrap it in `useCallback`), or this resubscribes. */
export function useReloadOnResourceChange(resource: SyncedResource, reload: () => unknown): void {
  useEffect(() => {
    function handleChange(event: Event): void {
      if (event instanceof CustomEvent && event.detail === resource) void reload()
    }

    window.addEventListener(RESOURCE_CHANGED_EVENT, handleChange)

    return () => {
      window.removeEventListener(RESOURCE_CHANGED_EVENT, handleChange)
    }
  }, [resource, reload])
}
