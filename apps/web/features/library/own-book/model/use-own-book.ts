'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OwnBookResponse } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { fetchOwnBook, saveOwnBookNote } from '../api/own-book-requests'

/** One resource, one key (CONVENTIONS §3.9): the read and the write below both name it. */
const ownBookQueryKey = (entryId: string) => ['own-book', entryId] as const

export type OwnBookState =
  | { status: 'loading' }
  /** 404: not this person's copy, or no such copy — the page cannot tell them apart, and must not. */
  | { status: 'not-found'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OwnBookResponse }

export interface NoteSave {
  pending: boolean
  error: unknown
  /** `true` once the server has accepted the note and the page shows it. */
  save: (note: string | null) => Promise<boolean>
  clearError: () => void
}

export interface OwnBook {
  state: OwnBookState
  retry: () => void
  noteSave: NoteSave
}

/**
 * The owner's page of one copy: the read, and the one write it has. Mount it only below the
 * session guard: it asks for the signed-in owner's data and has no business running before that.
 *
 * A saved note is put into the cache from the `PATCH` answer at once and the entry is then
 * invalidated, so the page shows what was saved even if the refresh that follows fails.
 */
export function useOwnBook(entryId: string): OwnBook {
  const queryClient = useQueryClient()
  const key = ownBookQueryKey(entryId)

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchOwnBook(entryId, signal),
    // A 404 is an answer, not a hiccup: retrying it only delays the "not found" page.
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: (note: string | null) => saveOwnBookNote(entryId, note),
    onSuccess: ({ copy }) => {
      queryClient.setQueryData<OwnBookResponse>(key, (current) =>
        current === undefined ? current : { ...current, copy },
      )

      return queryClient.invalidateQueries({ queryKey: key })
    },
  })

  async function save(note: string | null): Promise<boolean> {
    try {
      await mutation.mutateAsync(note)

      return true
    } catch {
      // The failure is on `mutation.error`; the form stays open with the draft in it.
      return false
    }
  }

  return {
    state: toState(query),
    retry: () => void query.refetch(),
    noteSave: {
      pending: mutation.isPending,
      error: mutation.error ?? undefined,
      save,
      clearError: mutation.reset,
    },
  }
}

function toState(query: {
  data: OwnBookResponse | undefined
  error: unknown
  isPending: boolean
}): OwnBookState {
  // Data on screen wins over a failed refresh: the person is looking at a real copy.
  if (query.data !== undefined) return { status: 'ready', data: query.data }

  if (query.isPending) return { status: 'loading' }

  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return { status: 'not-found', message: query.error.message }
  }

  return { status: 'error', message: describeError(query.error) }
}
