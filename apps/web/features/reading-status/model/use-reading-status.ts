'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadingStatus, ReadingStatusResponse } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { fetchReadingStatus, saveReadingStatus } from '../api/reading-status-requests'

export type ReadingStatusState =
  | { status: 'loading' }
  | { status: 'ready'; data: ReadingStatusResponse }
  | { status: 'error'; message: string }

export interface ReadingStatusController {
  state: ReadingStatusState
  reload: () => void
  /** The status whose `PUT` is in flight; the control stays locked until it settles. */
  saving: ReadingStatus | undefined
  /** Last confirmed save — cleared by the next attempt. */
  saved: ReadingStatus | undefined
  saveError: unknown
  /** What a retry re-sends: the status of the failed `PUT`. */
  failed: ReadingStatus | undefined
  save: (status: ReadingStatus) => Promise<void>
}

/**
 * Stage 10 (10j.2): the viewer's own status for one `Work`. Mount it keyed by the canonical work
 * id — a different work is a different resource, not a transition of this one.
 *
 * A failed save keeps the last confirmed status on screen (nothing optimistic to roll back) and
 * remembers the attempted status for a retry.
 */
export function useReadingStatus(workId: string): ReadingStatusController {
  const [state, setState] = useState<ReadingStatusState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const [saving, setSaving] = useState<ReadingStatus>()
  const [saved, setSaved] = useState<ReadingStatus>()
  const [saveError, setSaveError] = useState<unknown>()
  const [failed, setFailed] = useState<ReadingStatus>()

  // Synchronous guard against a second click landing before the disabled buttons re-render.
  const inFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    fetchReadingStatus(workId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: describeError(error) })
      })

    return () => {
      controller.abort()
    }
  }, [workId, nonce])

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    setNonce((value) => value + 1)
  }, [])

  async function save(target: ReadingStatus): Promise<void> {
    if (inFlight.current || state.status !== 'ready') return

    inFlight.current = true
    setSaving(target)
    setSaved(undefined)
    setSaveError(undefined)
    setFailed(undefined)

    try {
      const result = await saveReadingStatus(workId, target)

      if (!mounted.current) return

      setState((previous) =>
        previous.status === 'ready'
          ? { status: 'ready', data: { ...previous.data, status: result.status } }
          : previous,
      )
      setSaved(result.status)
    } catch (error) {
      if (!mounted.current) return

      setSaveError(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      setFailed(target)
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(undefined)
    }
  }

  return { state, reload, saving, saved, saveError, failed, save }
}
