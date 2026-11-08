'use client'

import { useState } from 'react'

type DraftState = {
  /** What the box shows: exactly what was typed. */
  draft: string
  /** The address's search as of the last render. */
  applied: string
  /** Searches this box wrote that the address has not shown yet, oldest first. */
  pending: readonly string[]
}

/** What the address holds for a typed search: blanks are no search (`loansFiltersHref`). */
function addressValueOf(typed: string): string {
  return typed.trim() === '' ? '' : typed
}

/**
 * The search box's text, kept apart from the `?q=` it writes.
 *
 * The box cannot show the address directly: Next renders a new address in a transition, so a
 * controlled input would snap back to the old text between keystrokes. So the box keeps what was
 * typed, and follows the address only when the address changed for another reason — the reset
 * button, a link to `/loans?role=owner` while a search is open.
 *
 * Telling the two apart is this hook's mechanism, and the one place that adjusts state during
 * render: a search this box wrote is remembered until the address shows it. An address that
 * arrives as one of those is this box's own echo — even an older one, overtaken by faster
 * typing — and leaves the text alone; any other address replaces it.
 */
export function useSearchDraft(applied: string, write: (query: string) => void) {
  const [state, setState] = useState<DraftState>({ draft: applied, applied, pending: [] })
  let current = state

  if (state.applied !== applied) {
    const echo = state.pending.indexOf(applied)

    current =
      echo === -1
        ? { draft: applied, applied, pending: [] }
        : { draft: state.draft, applied, pending: state.pending.slice(echo + 1) }
    setState(current)
  }

  return {
    draft: current.draft,
    change: (typed: string) => {
      const value = addressValueOf(typed)

      setState((previous) => {
        const last = previous.pending.at(-1) ?? previous.applied

        return {
          ...previous,
          draft: typed,
          pending: value === last ? previous.pending : [...previous.pending, value],
        }
      })
      write(typed)
    },
  }
}
