import {
  READING_STATUS,
  type ReadingStatus,
  type ReadingStatusResponse,
  type SetReadingStatusResponse,
} from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'

export type ReadingStatusView =
  | { kind: 'loading' }
  /** The status could not be read. Never shown as «not set»: that would be a claim we cannot make. */
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      /** `null` — nothing was ever set: the control shows its placeholder, not «Не читав». */
      current: ReadingStatus | null
      wasBorrowed: boolean
      /** A save of this work in flight from ANY control of it: all of them wait until it settles. */
      saving: ReadingStatus | undefined
      /** This control's last confirmed save — cleared by its next attempt. */
      saved: ReadingStatus | undefined
      /** An `ApiRequestError` as the API sent it, or any other failure described in words. */
      saveError: Error | undefined
      /** What a retry re-sends: the status of this control's failed save. */
      failed: ReadingStatus | undefined
    }

export interface ReadingStatusViewInput {
  query: { data: ReadingStatusResponse | undefined; error: unknown; isPending: boolean }
  /** Statuses whose `PUT` for this work is in flight, from any control. */
  saving: readonly ReadingStatus[]
  /** This control's own mutation. */
  own: {
    status: 'idle' | 'pending' | 'success' | 'error'
    variables: ReadingStatus | undefined
    data: SetReadingStatusResponse | undefined
    error: unknown
  }
}

/**
 * BS-140: what a reading-status control shows. A failed save changes nothing in the cache, so
 * `current` stays the last confirmed status; a failed background refresh keeps the data on screen.
 */
export function toReadingStatusView({
  query,
  saving,
  own,
}: ReadingStatusViewInput): ReadingStatusView {
  if (query.data === undefined) {
    return query.isPending
      ? { kind: 'loading' }
      : { kind: 'error', message: describeError(query.error) }
  }

  return {
    kind: 'ready',
    current: query.data.isSet ? query.data.status : null,
    wasBorrowed: query.data.wasBorrowed,
    saving: saving[0],
    saved: own.status === 'success' ? own.data?.status : undefined,
    saveError: own.status === 'error' ? toSaveError(own.error) : undefined,
    failed: own.status === 'error' ? own.variables : undefined,
  }
}

function toSaveError(error: unknown): Error {
  return error instanceof ApiRequestError ? error : new Error(describeError(error))
}

/** Mutation variables arrive as `unknown` from the shared mutation cache. */
export function asReadingStatus(value: unknown): ReadingStatus | undefined {
  return READING_STATUS.find((status) => status === value)
}
