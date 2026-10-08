'use client'

import { useState } from 'react'
import { copyResponseSchema, type UpdateCopyRequest } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import { toFailure } from './copy-rules'

interface CopyUpdateOptions {
  copyId: string
  /** The row's change is saved: the owner of the shelf reloads it. */
  onSaved: () => Promise<void>
  onFailure: (error: unknown) => void
}

export interface CopyUpdate {
  /** This row has a request in flight; it does not lock the other rows. */
  pending: boolean
  /** `afterSaved` runs once the server has accepted the change, before the shelf is reloaded. */
  patch: (body: UpdateCopyRequest, afterSaved?: () => void) => Promise<void>
}

/** `PATCH /me/library/:id` for one row: the request, the pending flag, and what a failure does. */
export function useCopyUpdate({ copyId, onSaved, onFailure }: CopyUpdateOptions): CopyUpdate {
  const [pending, setPending] = useState(false)

  async function patch(body: UpdateCopyRequest, afterSaved?: () => void): Promise<void> {
    setPending(true)

    try {
      await apiRequest(`/me/library/${copyId}`, {
        method: 'PATCH',
        body,
        schema: copyResponseSchema,
      })

      afterSaved?.()
      await onSaved()
    } catch (error) {
      onFailure(toFailure(error))
    } finally {
      setPending(false)
    }
  }

  return { pending, patch }
}
