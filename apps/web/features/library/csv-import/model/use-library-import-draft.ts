'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { LibraryImportDraftResponse, LibraryImportRowPatchRequest } from '@bookswap/shared'
import { useSession } from '@/app/lib/use-session'
import { invalidateActivation } from '@/features/library/activation/index.client'
import {
  commitLibraryImport,
  fetchLibraryImportDraft,
  patchLibraryImportRow,
} from '../api/library-import-requests'
import {
  classifyImportFailure,
  libraryImportQueryKey,
  type ImportFailure,
} from './import-draft-state'

export interface RowActionInput {
  rowNumber: number
  request: LibraryImportRowPatchRequest
}

/**
 * A row action this draft confirmed, identified by a counter rather than by its
 * content: two identical saves in a row are two separate events, and a form
 * waiting for "my save landed" has to be able to tell them apart.
 */
export interface ConfirmedRowAction {
  rowNumber: number
  id: number
}

export interface LibraryImportDraft {
  draft: LibraryImportDraftResponse | undefined
  isLoading: boolean
  /** Why the draft cannot be shown at all — 404, expired, 401, or a first load that failed. */
  loadFailure: ImportFailure | undefined
  /** A refresh failed while a draft is still on screen: a notice, not a replacement. */
  refreshFailure: ImportFailure | undefined
  /**
   * False from a `409` until a fresh draft has actually arrived. Until then the
   * rows on screen are known-stale, so nothing may claim to act on "the updated
   * row" — there is no updated row yet.
   */
  isDraftCurrent: boolean
  /** Why the last row action failed. Cleared when the next one starts. */
  actionFailure: ImportFailure | undefined
  /** The row whose action failed, so only that row shows the message. */
  failedRowNumber: number | undefined
  lastConfirmed: ConfirmedRowAction | undefined
  pendingRowNumber: number | undefined
  isMutating: boolean
  /** 8g: a commit is in flight. Row actions are blocked for its duration, and vice versa. */
  isCommitting: boolean
  /** Why the last commit failed — including which rows still need attention. */
  commitFailure: ImportFailure | undefined
  refresh: () => void
  dismissActionFailure: () => void
  runRowAction: (input: RowActionInput) => void
  /** 8g: import the draft exactly as it is on screen. A no-op while anything else is running. */
  commit: () => void
}

interface ActionContext {
  token: number
  queryKey: readonly [string, string]
  rowNumber: number
}

/**
 * Failures that must take the draft off the screen rather than sit beside it:
 * there is either nothing to show any more, or no longer a right to show it.
 * Everything else (a network blip, a 429) leaves the last known draft — and any
 * half-typed form over it — exactly where it was.
 */
const FATAL_FAILURES: ReadonlySet<ImportFailure['kind']> = new Set([
  'unauthorized',
  'not-found',
  'expired',
  'committed',
])

/**
 * Stage 8f-3: the whole client-side state of one import draft (R12).
 *
 * Three rules shape everything below, and each of them is a bug that has
 * already been reasoned about in the plan rather than a precaution:
 *
 * 1. **The server's answer is the draft.** A PATCH returns the entire
 *    recomputed document — editing one row can change another row's
 *    `DUPLICATE_ROW`, the counts and `readiness` — so the response replaces the
 *    cached document wholesale. Nothing is patched in place and nothing is
 *    guessed optimistically: a resolution the server has not confirmed is not a
 *    resolution.
 * 2. **One mutation at a time, and no stale write ever wins.** Row actions are
 *    serialized through a synchronous ref (not a disabled button, which only
 *    takes effect a render later), in-flight GETs are cancelled before a PATCH,
 *    and a response whose token or query key no longer matches is dropped
 *    instead of being written into the cache of a different draft or person.
 * 3. **409 is a question, not a retry.** `IMPORT_ROW_CONFLICT` re-reads the
 *    draft and stops. Re-applying the action is the user's explicit decision —
 *    and one they can only make once the re-read has actually succeeded, which
 *    is what `isDraftCurrent` tracks.
 */
export function useLibraryImportDraft(importId: string): LibraryImportDraft {
  const queryClient = useQueryClient()
  const { state: session } = useSession()
  const [actionFailure, setActionFailure] = useState<ImportFailure>()
  const [commitFailure, setCommitFailure] = useState<ImportFailure>()
  const [failedRowNumber, setFailedRowNumber] = useState<number>()
  const [lastConfirmed, setLastConfirmed] = useState<ConfirmedRowAction>()
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)
  /**
   * Latched, and it has to be: clearing the cache entry below removes the
   * query's own error with it, and deriving "fatal" from that error alone would
   * flip back to "fine", refetch, fail again and clear again — a loop.
   */
  const [fatalFailure, setFatalFailure] = useState<ImportFailure>()
  const confirmations = useRef(0)
  const token = useRef(0)
  // Synchronous: two calls landing in the SAME render batch must not become two
  // PATCHes, and `mutation.isPending` is a value from the last completed render
  // — it cannot possibly have flipped yet inside that batch.
  const running = useRef(false)
  /**
   * The session and draft this hook is currently about. Read by the latch
   * below, which outlives a render and must not answer for a different person.
   */
  const sessionKey = session.status === 'authenticated' ? session.user.id : session.status
  const identityKey = `${importId} ${sessionKey}`
  const identityRef = useRef(identityKey)
  /**
   * A commit the server has confirmed, latched the moment its response arrives.
   *
   * This is what closes the late-GET hole. A `GET` issued while the commit was
   * still in flight reads the draft BEFORE the commit's transaction lands, so it
   * comes back carrying rows — and a private note — for an import that is
   * already finished. Cancelling queries in `onMutate` does not cover it: that
   * read may well start after the mutation did. Guarding the render does not
   * cover it either, because by then the stale draft is in the cache, where
   * `getQueryData` and the next render can both still reach it.
   *
   * So the guard sits in the `queryFn`, where every read must pass regardless of
   * which one wins the race: after the fetch resolves, a confirmed commit wins
   * over whatever the server said a moment earlier.
   */
  const committedRef = useRef<
    { identityKey: string; draft: LibraryImportDraftResponse } | undefined
  >(undefined)

  const query = useQuery({
    queryKey: libraryImportQueryKey(importId),
    queryFn: async ({ signal }) => {
      const fetched = await fetchLibraryImportDraft(importId, signal)
      const confirmed = committedRef.current

      if (confirmed !== undefined && confirmed.identityKey === identityRef.current) {
        return confirmed.draft
      }

      return fetched
    },
    // Stopped for good once the answer is 401/404/410: retrying would only ask
    // the same question again, and would fight the cache clearing below.
    enabled: fatalFailure === undefined,
    // §3.9 allows a considered retry on GET; this one is none. Every failure
    // here is a state the UI renders on purpose (404, expired, 401, 429), and
    // repeating the request would only delay the honest answer.
    retry: false,
    // An open edit form must never be handed a new baseline behind the user's
    // back: a background refetch that swapped `rowVersion` under a half-typed
    // form would make the next PATCH claim to act on a state nobody looked at.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // "Latest ref" for `refetch`, so the conflict handler below can re-read the
  // draft without depending on a query object that is new every render.
  const refetchRef = useRef(query.refetch)

  useEffect(() => {
    refetchRef.current = query.refetch
  })

  /** Re-reads the draft and reports whether the rows on screen are current again. */
  async function runRefresh(expectedToken: number): Promise<void> {
    const result = await refetchRef.current()

    if (expectedToken !== token.current) return
    if (!result.isError) setAwaitingRefresh(false)
  }

  const mutation = useMutation<LibraryImportDraftResponse, unknown, RowActionInput, ActionContext>({
    mutationKey: ['library-import', importId, 'row-action'],
    retry: false,
    mutationFn: ({ rowNumber, request }) => patchLibraryImportRow({ importId, rowNumber, request }),
    onMutate: async ({ rowNumber }) => {
      const queryKey = libraryImportQueryKey(importId)

      // A GET already in flight would otherwise land AFTER this PATCH and
      // overwrite the newer draft with the older one it started fetching.
      await queryClient.cancelQueries({ queryKey })
      token.current += 1
      setActionFailure(undefined)
      setFailedRowNumber(undefined)

      return { token: token.current, queryKey, rowNumber }
    },
    onSuccess: (draft, _variables, context) => {
      running.current = false

      // Superseded by an identity change (another draft, another person) while
      // this was in flight: writing it now would show one user's rows to the
      // next, or one draft's rows under another draft's id.
      if (context.token !== token.current) return

      queryClient.setQueryData(context.queryKey, draft)
      setAwaitingRefresh(false)
      confirmations.current += 1
      // What an open form on this row needs in order to move its own baseline
      // forward — and only its own.
      setLastConfirmed({ rowNumber: context.rowNumber, id: confirmations.current })
    },
    onError: (error, _variables, context) => {
      running.current = false

      if (context === undefined || context.token !== token.current) return

      const failure = classifyImportFailure(error)

      // A PATCH answers 401/404/410 just as authoritatively as a GET does, and
      // it is believed on its own — there is nothing a follow-up GET could add
      // except a window in which a draft nobody may read any more stays on
      // screen and in the cache. The row-level error is deliberately NOT set:
      // this is not one row's problem, the whole draft is gone.
      // A PATCH answers 401/404/410 just as authoritatively as a GET does, and
      // it is believed on its own — there is nothing a follow-up GET could add
      // except a window in which a draft nobody may read any more stays on
      // screen and in the cache. The row-level error is deliberately NOT set:
      // this is not one row's problem, the whole draft is gone.
      if (FATAL_FAILURES.has(failure.kind)) {
        setFatalFailure(failure)

        return
      }

      setActionFailure(failure)
      setFailedRowNumber(context.rowNumber)

      // 409: re-read the draft so the user sees what it actually is now. The
      // mutation itself is NOT repeated — that decision is theirs, and their
      // typed values are still in the form, untouched. Until the re-read lands,
      // the rows on screen are stale and `isDraftCurrent` says so.
      if (failure.kind === 'conflict') {
        setAwaitingRefresh(true)
        void runRefresh(context.token)
      }
    },
  })

  /**
   * 8g: the commit shares this hook — and, crucially, the SAME `running` gate,
   * `token` and identity guard as the row actions.
   *
   * Two mutations over one cached document must not be able to run at once: a
   * row PATCH landing during a commit would write a draft back over a summary
   * the server has already declared final. One gate is what makes that
   * unrepresentable, rather than unlikely.
   */
  const commitMutation = useMutation<
    LibraryImportDraftResponse,
    unknown,
    string,
    { token: number }
  >({
    mutationKey: ['library-import', importId, 'commit'],
    // §3.9: a mutation is never retried by the library. A commit that timed
    // out may well have succeeded, and asking again on the user's behalf is
    // the one thing idempotency should not have to clean up after.
    retry: false,
    mutationFn: async (expectedDraftVersion) => {
      const identity = identityRef.current
      const committedDraft = await commitLibraryImport(importId, expectedDraftVersion)

      // Latched here rather than in `onSuccess`: that runs a microtask later,
      // and a `GET` resolving in between would slip its stale draft into the
      // cache through the very gap this latch exists to close.
      committedRef.current = { identityKey: identity, draft: committedDraft }

      return committedDraft
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: libraryImportQueryKey(importId) })
      token.current += 1
      setCommitFailure(undefined)

      return { token: token.current }
    },
    onSuccess: (committed, _variables, context) => {
      running.current = false

      // Stage 8h-2: the commit created copies, so the activation checklist is
      // out of date wherever it is mounted. Deliberately NOT behind the token
      // guard below: that guard exists to stop a superseded response being
      // WRITTEN into the cache, and this writes nothing — it only marks a key
      // stale. The books exist either way.
      void invalidateActivation(queryClient)

      if (context.token !== token.current) return

      // The confirmed result replaces the draft immediately, and no refetch
      // follows: the answer already IS the final summary, and the rows it no
      // longer carries are rows nobody may read again. A later failing GET
      // therefore cannot take this success back — there is nothing left for
      // it to overwrite it with.
      queryClient.setQueryData(libraryImportQueryKey(importId), committed)
      setAwaitingRefresh(false)
      setActionFailure(undefined)
      setFailedRowNumber(undefined)
    },
    onError: (error, _variables, context) => {
      running.current = false

      if (context === undefined || context.token !== token.current) return

      const failure = classifyImportFailure(error)

      if (FATAL_FAILURES.has(failure.kind)) {
        setFatalFailure(failure)

        return
      }

      setCommitFailure(failure)

      // The draft moved under the request, or rows still need attention: the
      // honest next screen is the draft as it actually is now.
      if (failure.kind === 'not-ready' || failure.kind === 'conflict') {
        setAwaitingRefresh(true)
        void runRefresh(context.token)
      }
    },
  })

  const queryFailure = query.error === null ? undefined : classifyImportFailure(query.error)

  // Latched during render, not in an effect — the same "adjust state while
  // rendering" pattern `use-resource.ts` documents. The branch only runs while
  // `fatalFailure` is still unset, so it fires once per transition rather than
  // on every render.
  if (
    fatalFailure === undefined &&
    queryFailure !== undefined &&
    FATAL_FAILURES.has(queryFailure.kind)
  ) {
    setFatalFailure(queryFailure)
  }

  // The draft holds a private `note`. Once the answer is "you may not read
  // this", it does not stay in the cache waiting for the next reader — hiding
  // it from the render alone would leave it readable through `getQueryData`.
  //
  // The token bump is the other half: a request that was already in flight when
  // the refusal arrived would otherwise settle afterwards and put the draft
  // straight back, through the very `setQueryData` that just got cleaned up.
  useEffect(() => {
    if (fatalFailure === undefined) return

    token.current += 1
    running.current = false
    queryClient.removeQueries({ queryKey: libraryImportQueryKey(importId), exact: true })
  }, [fatalFailure, importId, queryClient])

  // Same guard as the correction feature (8e-3): a late callback from a
  // PREVIOUS draft or a PREVIOUS person must not surface as this one's state.
  const previousIdentityKey = useRef(identityKey)

  useEffect(() => {
    if (previousIdentityKey.current === identityKey) return

    previousIdentityKey.current = identityKey
    // Both before anything else: a late commit response settling after this
    // point must not be able to answer for the person who just arrived.
    identityRef.current = identityKey
    committedRef.current = undefined
    token.current += 1
    running.current = false
    setActionFailure(undefined)
    setCommitFailure(undefined)
    setFailedRowNumber(undefined)
    setLastConfirmed(undefined)
    setAwaitingRefresh(false)
    setFatalFailure(undefined)
  }, [identityKey])

  const draft = fatalFailure === undefined ? query.data : undefined

  return {
    draft,
    isLoading: query.isPending && fatalFailure === undefined,
    loadFailure: fatalFailure ?? (draft === undefined ? queryFailure : undefined),
    refreshFailure: draft === undefined ? undefined : queryFailure,
    isDraftCurrent: !awaitingRefresh,
    actionFailure,
    failedRowNumber,
    lastConfirmed,
    pendingRowNumber: mutation.isPending ? mutation.variables?.rowNumber : undefined,
    isMutating: mutation.isPending || commitMutation.isPending,
    isCommitting: commitMutation.isPending,
    commitFailure,
    refresh: () => {
      void runRefresh(token.current)
    },
    dismissActionFailure: () => {
      setActionFailure(undefined)
      setFailedRowNumber(undefined)
    },
    runRowAction: (input) => {
      if (running.current || mutation.isPending || commitMutation.isPending) return

      running.current = true
      mutation.mutate(input)
    },
    commit: () => {
      // The same synchronous gate the row actions use, for the same reason: two
      // clicks inside one render batch must not become two requests, and
      // `isPending` is a value from the last completed render — it cannot have
      // flipped yet inside that batch.
      if (running.current || mutation.isPending || commitMutation.isPending) return

      const current = queryClient.getQueryData<LibraryImportDraftResponse>(
        libraryImportQueryKey(importId),
      )

      // Committing needs the version of the draft that is actually on screen.
      // Without one there is nothing honest to send, and inventing a value
      // would ask the server to skip the very check it exists for.
      if (current === undefined) return

      running.current = true
      commitMutation.mutate(current.draftVersion)
    },
  }
}
