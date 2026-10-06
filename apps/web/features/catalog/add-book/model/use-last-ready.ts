'use client'

import { useState } from 'react'

/**
 * Remembers the last defined `value` while `active`, and forgets it the moment `active` ends.
 *
 * Suggestions do not jump: while a new request is in flight the previous list stays and is replaced
 * as a whole, not card by card. Outside suggestion mode nothing is remembered, so a stale list can
 * never leak into a full search.
 *
 * The state is adjusted during render (React's "derive state from props" pattern), not in an effect:
 * an effect would paint one frame with the previous mode's list.
 */
export function useLastReady<T>(value: T | undefined, active: boolean): T | undefined {
  const [last, setLast] = useState<T>()

  if (active && value !== undefined && value !== last) setLast(value)
  else if (!active && last !== undefined) setLast(undefined)

  return last
}
