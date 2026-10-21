'use client'

import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReadingStatus, ReadingStatusResponse } from '@bookswap/shared'
import { loadReadingStatus } from '../api/reading-status-batch'
import { saveReadingStatus } from '../api/reading-status-requests'
import { asReadingStatus, toReadingStatusView, type ReadingStatusView } from './reading-status-view'
import { refreshReadingStats } from './use-reading-stats'

/**
 * BS-140: the one key of «this user's status of this work» (CONVENTIONS §3.9). Every control of the
 * work — the cards of its editions on the shelf, the own-book page, the work page — reads it, and a
 * save writes it, so they cannot disagree. The user is part of the key: another account in the same
 * tab never reads this entry, even before `Providers` clears the cache.
 */
export const readingStatusQueryKey = (userId: string, workId: string) =>
  ['reading-status', userId, workId] as const

/**
 * How long a status is trusted without asking again. Going from the shelf to a book and back would
 * otherwise re-read every card; a save updates the entry directly whatever this is.
 */
const READING_STATUS_STALE_MS = 30_000

export interface ReadingStatusController {
  view: ReadingStatusView
  retryLoad: () => void
  save: (status: ReadingStatus) => void
  retrySave: () => void
}

/**
 * The viewer's own status of one `Work`. Mount it below the session guard, keyed by user and work:
 * another account or another work is another resource, not a transition of this one — so this
 * control's save state (pending, saved, failed) never carries over.
 *
 * A merged work is read as its canonical one (the answer's `workId`). From the moment a read of
 * `workId` names another work, this control reads, saves and locks by that canonical work's entry,
 * like every control of it — so cards of the merged work and of the work it went into cannot
 * disagree, nor save over each other. Until then a save goes to `workId`, and the server refuses it
 * for a merged work (409 `WORK_MERGED`): that stays an error, never redirected or repeated.
 *
 * A confirmed save first cancels every read of the saved entry still in flight — whether it started
 * before the `PUT` or during it, single or batched — and then writes the answer into the cache. A
 * read that landed earlier is simply overwritten, so no old answer can put the previous status back.
 * Nothing is optimistic: a failed save leaves the confirmed status on screen with nothing to roll
 * back — and leaves the reading stats alone, which only a confirmed save marks out of date.
 */
export function useReadingStatus({
  userId,
  workId,
}: {
  userId: string
  workId: string
}): ReadingStatusController {
  const queryClient = useQueryClient()
  const requestedKey = readingStatusQueryKey(userId, workId)

  // Which work `workId` is. Only the id is taken from this entry: for a merged work it holds the
  // canonical work's answer from when it was read, and the status lives in the canonical entry.
  const requested = useQuery({
    ...statusQuery(requestedKey, workId),
    select: (status) => status.workId,
  })
  const canonicalWorkId = requested.data ?? workId
  const key = readingStatusQueryKey(userId, canonicalWorkId)

  const query = useQuery({
    ...statusQuery(key, canonicalWorkId),
    // The canonical entry starts from the answer that named it, if nothing read it yet — so a merged
    // work's card does not ask again for what it has just been told. It never replaces an entry.
    initialData: () => {
      const named = queryClient.getQueryData<ReadingStatusResponse>(requestedKey)

      return named?.workId === canonicalWorkId ? named : undefined
    },
    initialDataUpdatedAt: () => queryClient.getQueryState(requestedKey)?.dataUpdatedAt,
  })

  const saving = useMutationState({
    filters: { mutationKey: key, exact: true, status: 'pending' },
    select: (mutation) => asReadingStatus(mutation.state.variables),
  }).filter((status) => status !== undefined)

  const mutation = useMutation({
    mutationKey: key,
    mutationFn: (status: ReadingStatus) => saveReadingStatus(canonicalWorkId, status),
    onSuccess: async (saved) => {
      // The entry of the work the server saved — the key this save was started under.
      const savedKey = readingStatusQueryKey(userId, saved.workId)

      await queryClient.cancelQueries({ queryKey: savedKey, exact: true })
      // No entry means the cache was cleared meanwhile (another account signed in): `undefined` from
      // the updater leaves it that way instead of inventing a status without `wasBorrowed`.
      queryClient.setQueryData<ReadingStatusResponse>(
        savedKey,
        (current) => current && { ...current, status: saved.status, isSet: true },
      )
      // BS-145: the home page's counts follow every confirmed save, from whichever control.
      void refreshReadingStats(queryClient, userId)
    },
  })

  const view = toReadingStatusView({
    query,
    saving,
    own: {
      status: mutation.status,
      variables: mutation.variables,
      data: mutation.data,
      error: mutation.error,
    },
  })

  function save(status: ReadingStatus): void {
    // Synchronous, unlike the disabled control: a second choice can land before it re-renders. The
    // mutation cache marks a started save pending at once, whichever control started it.
    if (queryClient.isMutating({ mutationKey: key, exact: true }) > 0) return
    if (view.kind !== 'ready' || view.current === status) return

    mutation.mutate(status)
  }

  return {
    view,
    retryLoad: () => {
      void query.refetch()
    },
    save,
    retrySave: () => {
      if (view.kind === 'ready' && view.failed !== undefined) save(view.failed)
    },
  }
}

/** The read of one entry: what both the requested and the canonical entry are filled with. */
function statusQuery(key: ReturnType<typeof readingStatusQueryKey>, workId: string) {
  return {
    queryKey: key,
    queryFn: () => loadReadingStatus(workId),
    // A failed read shows its error with a retry button; repeating it on its own only delays that.
    retry: false,
    staleTime: READING_STATUS_STALE_MS,
  }
}
