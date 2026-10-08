'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { copyResponseSchema, type OwnCopy } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { invalidateActivation } from '@/features/library/activation/index.client'
import { toFailure } from './copy-rules'

export interface ShelfActions {
  /** The last failure to show above the shelf; any new action clears it. */
  failure: unknown
  /** One action at a time: while it is in flight, and until the shelf is reloaded, the rest wait. */
  isBusy: boolean
  /** The copy the delete dialog is asking about. */
  pendingDelete: OwnCopy | undefined
  reportFailure: (error: unknown) => void
  askToDelete: (copy: OwnCopy) => void
  cancelDelete: () => void
  confirmDelete: () => void
  archive: (copy: OwnCopy) => void
  restore: (copy: OwnCopy) => void
}

/**
 * The shelf-level actions that change which copies exist or count: delete, archive, restore.
 *
 * Each one is a request, then the activation checklist hears about it, then the shelf is reloaded,
 * and it is `run` that owns that order, so a new action cannot forget a step.
 */
export function useShelfActions(reload: () => Promise<void>): ShelfActions {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<unknown>()
  const [isBusy, setIsBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<OwnCopy>()

  async function run(request: () => Promise<unknown>): Promise<void> {
    setFailure(undefined)
    setIsBusy(true)

    try {
      await request()
      // Stage 8h-2: each of these changes what the checklist above the shelf counts (a copy fewer
      // is a step back from ten; an archived copy does not count, and a restored one does again),
      // so the checklist has to hear about it. After the request resolved: a failed request throws
      // before this line, and nothing is invalidated for a change that never happened. The legacy
      // `reload()` below is still needed — the two readers share no cache (R12).
      await invalidateActivation(queryClient)
      // `await`: the buttons stay locked until the new list arrives.
      await reload()
    } catch (error) {
      setFailure(toFailure(error))
    } finally {
      setIsBusy(false)
      setPendingDelete(undefined)
    }
  }

  const setArchived = (copy: OwnCopy, action: 'archive' | 'restore'): void => {
    void run(() =>
      apiRequest(`/me/library/${copy.id}/${action}`, {
        method: 'POST',
        schema: copyResponseSchema,
      }),
    )
  }

  return {
    failure,
    isBusy,
    pendingDelete,
    reportFailure: setFailure,
    askToDelete: setPendingDelete,
    cancelDelete: () => {
      setPendingDelete(undefined)
    },
    confirmDelete: () => {
      if (pendingDelete === undefined) return

      void run(() => apiRequest(`/me/library/${pendingDelete.id}`, { method: 'DELETE' }))
    },
    archive: (copy) => {
      setArchived(copy, 'archive')
    },
    restore: (copy) => {
      setArchived(copy, 'restore')
    },
  }
}
