'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isValidIsbn13 } from '@bookswap/shared'
import {
  AUTO_EXTERNAL_DELAY_MS,
  AUTO_EXTERNAL_MIN_CHARS,
  AUTO_LOCAL_DELAY_MS,
  AUTO_LOCAL_MIN_CHARS,
  normalizeQuery,
} from './auto-search'

export interface AutoSearchInput {
  /** What the field holds now, as typed. It is a DRAFT — the executed query lives in the address. */
  draft: string
  /** `q` of the address, normalized. */
  urlQuery: string
  /** Run the full search of this text: `router.replace`, first page, no scrolling. */
  onSearch: (query: string) => void
  /** The field went below a search: drop the search typing wrote into the address. */
  onClear: () => void
  /** A valid ISBN-13: the exact path, no waiting. */
  onExact: (isbn: string) => void
}

export interface AutoSearch {
  /** The draft, normalized. */
  normalized: string
  /**
   * The text whose external half may be asked (`externalGateOf`). The address the page opened with,
   * an explicit search or an outside address releases its query at once; typing — after its own pause.
   */
  externalReleased: string | undefined
  /** The normalized draft has not reached the address yet (waiting for the pause, or IME is composing). */
  localPending: boolean
  /** Props for the `<input>`: IME composition. */
  composition: {
    onCompositionStart: () => void
    onCompositionEnd: () => void
  }
  /** Drop pending launches — before an explicit search. */
  cancel: () => void
  /** An explicit search or an outside address (Back/Forward, the scanner): its external half is asked now. */
  release: (query: string) => void
}

/**
 * Search while typing (BS-134): WHEN what runs. The hook loads nothing — it decides and calls back; the
 * screen's queries follow the address and `externalReleased`.
 *
 * - below 2 characters — nothing; from 2 — after `AUTO_LOCAL_DELAY_MS` the FULL search of the text runs
 *   (its first page, our catalog at once); from 3 — after `AUTO_EXTERNAL_DELAY_MS` its external half
 *   is released too. The timers are INDEPENDENT and count from the LAST change of the text: the first
 *   to fire does not reset the other.
 * - IME: no timers while composing; `compositionend` starts them for the finished text.
 * - a valid ISBN-13 — no waiting (`onExact`); «1984» is not one.
 * - normalized strings are compared: a change of whitespace alone starts nothing.
 *
 * The timers depend on the text and the composition only, not on the address: otherwise the
 * `replace` the local timer makes would restart the external one, and it would fire at `350 + 900` ms.
 */
export function useAutoSearch(input: AutoSearchInput): AutoSearch {
  const normalized = normalizeQuery(input.draft)
  const [composing, setComposing] = useState(false)
  // The address the page opened with is a search someone asked for: no pause for it.
  const [externalReleased, setExternalReleased] = useState<string | undefined>(input.urlQuery)
  const latest = useRef(input)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    latest.current = input
  })

  const cancel = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)

    timers.current = []
  }, [])

  const release = useCallback((query: string) => {
    setExternalReleased(query)
  }, [])

  useEffect(() => {
    if (composing) return

    const current = latest.current

    if (normalized.length < AUTO_LOCAL_MIN_CHARS) {
      if (current.urlQuery !== '') current.onClear()

      return
    }

    if (isValidIsbn13(normalized)) {
      if (normalized !== current.urlQuery) current.onExact(normalized)

      return
    }

    // The rest is decided when a timer fires: the address may change within these 350–900 ms.
    timers.current = [
      setTimeout(() => {
        if (normalized !== latest.current.urlQuery) latest.current.onSearch(normalized)
      }, AUTO_LOCAL_DELAY_MS),
    ]

    if (normalized.length >= AUTO_EXTERNAL_MIN_CHARS) {
      timers.current.push(
        setTimeout(() => {
          setExternalReleased(normalized)
        }, AUTO_EXTERNAL_DELAY_MS),
      )
    }

    return cancel
  }, [normalized, composing, cancel])

  const isbn = isValidIsbn13(normalized)
  const eligible = !composing && !isbn && normalized.length >= AUTO_LOCAL_MIN_CHARS

  return {
    normalized,
    externalReleased,
    localPending: composing || (eligible && normalized !== input.urlQuery),
    composition: {
      onCompositionStart: () => {
        setComposing(true)
      },
      onCompositionEnd: () => {
        setComposing(false)
      },
    },
    cancel,
    release,
  }
}
