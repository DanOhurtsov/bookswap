'use client'

import { useSyncExternalStore } from 'react'

/**
 * Чи збігається поточний вигляд із медіа-запитом. Серверний рендер і середовище без
 * `matchMedia` (jsdom) дають `false` — тобто «вузький екран»: мобільний вигляд є безпечним
 * початковим станом, а справжнє значення з'являється після гідратації.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined
      }

      const list = window.matchMedia(query)

      list.addEventListener('change', notify)

      return () => {
        list.removeEventListener('change', notify)
      }
    },
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false,
  )
}
