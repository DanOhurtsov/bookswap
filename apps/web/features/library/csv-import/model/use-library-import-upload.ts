'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { LibraryImportDraftResponse } from '@bookswap/shared'
import { useSession } from '@/app/lib/use-session'
import { previewLibraryImport } from '../api/library-import-requests'
import { readImportFileAsBase64, type ImportFileReadFailure } from './import-file'
import {
  classifyImportFailure,
  formatKib,
  libraryImportQueryKey,
  type ImportFailure,
} from './import-draft-state'

export interface LibraryImportUpload {
  isUploading: boolean
  /** A problem with the file itself, found locally before any request. */
  localError: string | undefined
  uploadFailure: ImportFailure | undefined
  upload: (file: File) => void
  reset: () => void
}

interface UploadVariables {
  file: File
  /** The identity this upload was started for — see `useLibraryImportUpload`. */
  token: number
}

/**
 * Stage 8f-3: `POST /me/library/imports/preview`, then straight to the draft's
 * own URL.
 *
 * The URL is the point. A draft lives 24 hours server-side, so the only thing
 * the browser needs to come back to it is its id — which is why nothing about
 * the file, the draft or the private `note` is kept in `localStorage`.
 *
 * **Session isolation.** `queryClient.clear()` on identity change (§3.9,
 * `query-client.tsx`) is necessary but NOT sufficient here, and the gap is
 * exactly the request that was already in flight when the identity changed: it
 * settles *after* the clear, and its `setQueryData` would put one person's
 * draft into the cache the next person is about to read — with a `router.push`
 * sending them straight to it. So every upload carries the identity token it
 * was started for, and it is checked three times:
 *
 * - after the file is read, BEFORE the request goes out — reading a `File` is
 *   asynchronous, and bytes chosen by one person must never be uploaded on
 *   behalf of another;
 * - on success, before touching the cache or navigating;
 * - on failure, before showing an error that belongs to a session that is over.
 *
 * Unmounting counts as an identity change for the same reason: the person left
 * the upload screen, and a late answer must not drag them back to it.
 */
export function useLibraryImportUpload(): LibraryImportUpload {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { state: session } = useSession()
  const [localError, setLocalError] = useState<string>()
  // Not derived from `mutation.error`: TanStack keeps its own error state
  // regardless of what `onError` decides, so a dropped stale failure would
  // still surface through it.
  const [failure, setFailure] = useState<ImportFailure>()
  const token = useRef(0)
  // Blocks a genuinely synchronous double submit — two clicks in the same
  // batch, before React re-renders with the button disabled.
  const running = useRef(false)

  const mutation = useMutation<LibraryImportDraftResponse, unknown, UploadVariables>({
    mutationKey: ['library-import', 'preview'],
    retry: false,
    mutationFn: async ({ file, token: startedAt }) => {
      const read = await readImportFileAsBase64(file)

      if (!read.ok) throw new LocalFileError(read)
      if (startedAt !== token.current) throw new StaleSessionError()

      return previewLibraryImport(read.format, read.contentBase64)
    },
    onSuccess: (draft, variables) => {
      running.current = false

      if (variables.token !== token.current) return

      // Seeded so the draft page renders immediately from the answer we already
      // have, under the same canonical key its own query reads (R12).
      queryClient.setQueryData(libraryImportQueryKey(draft.import.id), draft)
      router.push(`/library/imports/${draft.import.id}`)
    },
    onError: (error, variables) => {
      running.current = false

      if (variables.token !== token.current) return

      if (error instanceof LocalFileError) {
        setLocalError(error.describe())

        return
      }

      setFailure(classifyImportFailure(error))
    },
  })

  // "Latest ref" for `mutation.reset`, for the same reason `useCatalogCorrection`
  // needs one: the effect below must call the current render's `reset` without
  // depending on the mutation object, which is new on every render.
  const resetMutationRef = useRef(mutation.reset)

  useEffect(() => {
    resetMutationRef.current = mutation.reset
  })

  const sessionKey = session.status === 'authenticated' ? session.user.id : session.status
  const previousSessionKey = useRef(sessionKey)

  useEffect(() => {
    if (previousSessionKey.current === sessionKey) return

    previousSessionKey.current = sessionKey
    token.current += 1
    running.current = false
    setLocalError(undefined)
    setFailure(undefined)
    resetMutationRef.current()
  }, [sessionKey])

  useEffect(
    () => () => {
      // Leaving the screen invalidates anything still in flight for it.
      token.current += 1
    },
    [],
  )

  return {
    isUploading: mutation.isPending,
    localError,
    uploadFailure: failure,
    upload: (file) => {
      if (running.current || mutation.isPending) return

      running.current = true
      setLocalError(undefined)
      setFailure(undefined)
      mutation.mutate({ file, token: token.current })
    },
    reset: () => {
      setLocalError(undefined)
      setFailure(undefined)
      mutation.reset()
    },
  }
}

/**
 * A file rejected before it was ever sent. Its own class so that it is never
 * mistaken for an API failure: there is no status, no code and nothing to retry
 * against the server — the person has to pick a different file.
 */
class LocalFileError extends Error {
  constructor(readonly failure: ImportFileReadFailure) {
    super('Файл не пройшов локальну перевірку')
    this.name = 'LocalFileError'
  }

  describe(): string {
    if (this.failure.reason === 'EMPTY') return 'Файл порожній.'

    if (this.failure.reason === 'UNSUPPORTED_EXTENSION') {
      return 'Підтримуємо лише файли .csv і .xlsx. Старий формат .xls, .xlsm і захищені паролем файли не підходять — збережіть незахищену копію у форматі .xlsx.'
    }

    return `Файл завеликий: ${formatKib(this.failure.size)}, а для цього формату дозволено щонайбільше ${formatKib(this.failure.limit)}.`
  }
}

/**
 * The identity changed between choosing the file and sending it. Nothing is
 * reported to anyone: the person who started this is gone, and the person who
 * is here now did not ask for it.
 */
class StaleSessionError extends Error {
  constructor() {
    super('Сесія змінилася, поки читався файл')
    this.name = 'StaleSessionError'
  }
}
