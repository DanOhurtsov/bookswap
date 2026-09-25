'use client'

import { useCallback, useEffect, useState } from 'react'
import type { WorkHoldersResponse } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { fetchWorkHolders } from '../api/network-requests'

export type HoldersState =
  | { status: 'loading' }
  | { status: 'ready'; data: WorkHoldersResponse }
  | { status: 'error'; message: string }

/** Friends' copies of a work; `reload` resolves only after the fresh answer has landed. */
export function useWorkHolders(workId: string): {
  state: HoldersState
  reload: () => Promise<void>
} {
  const [state, setState] = useState<HoldersState>({ status: 'loading' })

  const reload = useCallback(async (): Promise<void> => {
    try {
      const { data } = await fetchWorkHolders(workId)

      setState({ status: 'ready', data })
    } catch (error) {
      setState({ status: 'error', message: describeError(error) })
    }
  }, [workId])

  useEffect(() => {
    const controller = new AbortController()

    fetchWorkHolders(workId, controller.signal)
      .then(({ data }) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: describeError(error) })
      })

    return () => {
      controller.abort()
    }
  }, [workId])

  return { state, reload }
}
