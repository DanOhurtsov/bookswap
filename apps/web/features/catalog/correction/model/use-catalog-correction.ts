'use client'

import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { WorkReloadOutcome } from '@/app/lib/use-catalog'
import { useSession } from '@/app/lib/use-session'

/**
 * `optimistic` — the user's own submitted guess, shown before the server has
 * answered. `confirmed` — the authoritative entity from a successful PATCH
 * response; it does not wait for `useWork`'s own refresh to land, since the
 * PATCH response already IS the fresh truth for this one entity (R12).
 */
export type CorrectionOverlay<TEntity> =
  { phase: 'optimistic'; entity: TEntity } | { phase: 'confirmed'; entity: TEntity } | undefined

interface Variables<TRequest, TEntity> {
  body: TRequest
  optimisticEntity: TEntity
}

interface MutateContext<TEntity> {
  token: number
  previousOverlay: CorrectionOverlay<TEntity>
}

export interface UseCatalogCorrectionOptions<TRequest, TEntity> {
  mutationKey: readonly unknown[]
  mutationFn: (body: TRequest) => Promise<TEntity>
  /** `useWork().reload` (R12) — awaited only to sync the rest of the page. */
  reload: () => Promise<WorkReloadOutcome>
  /** Extracts the entity's own revision — Work wraps it as `entity.work.revision`. */
  revisionOf: (entity: TEntity) => number
  /**
   * The id of the entity THIS instance corrects (Work/Translation/Edition id).
   * Identifies when the same component instance now points at a DIFFERENT
   * entity — e.g. `WorkPage` staying mounted across a client-side navigation
   * from one Work to another — so overlay/error/success state from the old
   * entity is never shown against the new one.
   */
  entityId: string
}

export interface CatalogCorrection<TRequest, TEntity> {
  overlay: CorrectionOverlay<TEntity>
  saveError: unknown
  /**
   * True from a successful PATCH until the next `submit()` call — independent
   * of `overlay`, which `resolve()` may already have cleared by then. Use
   * this (not `overlay?.phase === 'confirmed'`) to show a "saved" banner.
   */
  justSaved: boolean
  /**
   * The entity from the most recently successful PATCH — set once per
   * success, and NOT touched by `resolve()` (unlike `overlay`, which may
   * already have reconciled away by the time a form's own effect gets to
   * look at it — `resolve()` runs in the ancestor that owns this hook,
   * during ITS render, which can easily happen before a child form even
   * re-renders). A form's baseline-sync effect (`expectedRevision`, R10a
   * author ids) should depend on THIS, not on `overlay`.
   *
   * This is "the last save this hook instance confirmed", full stop — NOT
   * "a save that just happened". A form that (re)mounts while an OLD confirm
   * is already sitting here must not treat it as a fresh event: see the
   * `confirmedAtMountRef` pattern each correction form uses around this.
   */
  confirmed: TEntity | undefined
  /** Set only when the PATCH itself succeeded but the follow-up page refresh failed. */
  refreshNotice: string | undefined
  isSaving: boolean
  submit: (body: TRequest, optimisticEntity: TEntity) => void
  dismissRefreshNotice: () => void
  /**
   * Call during render with the entity as `useWork` currently knows it.
   *
   * - While a PATCH is still pending (`overlay.phase === 'optimistic'`),
   *   this ALWAYS returns the optimistic guess — never compared against
   *   `fresh` by revision. The guess carries the entity's OLD revision (the
   *   new one isn't known yet), so a fresh snapshot at that same revision is
   *   not "caught up", it is simply "hasn't changed yet"; treating it as
   *   confirmation would make the optimistic value disappear the instant it
   *   appears.
   * - Once a PATCH is `confirmed` (a real, server-issued revision), THIS
   *   comparison is meaningful: while the snapshot is still behind, the
   *   overlay keeps showing (through a failed refresh, or after the form
   *   that made it closes); once the snapshot catches up — or moves past,
   *   because someone else changed the entity meanwhile — this returns the
   *   snapshot and clears the overlay, so a stale overlay can never shadow
   *   newer data.
   */
  resolve: (fresh: TEntity) => TEntity
}

/**
 * Shared optimistic-mutation lifecycle for the three catalog correction forms
 * (`PATCH /works/:id`, `/translations/:id`, `/editions/:id`) — R12/§3.9.
 *
 * Not a general-purpose mutation adapter: it exists because all three PATCH
 * forms share the exact same, easy-to-get-wrong concurrency rules, and
 * duplicating this three times would duplicate the bugs, not just the code:
 *
 * - a stale mutation's error must never roll back a LATER mutation's already
 *   confirmed change (§3.9) — guarded by `token`, not by "was this the last
 *   call made";
 * - a successful PATCH is never retried automatically, and a refresh failure
 *   AFTER a successful PATCH is reported as `refreshNotice`, not `saveError`
 *   — the two render as different, non-alarming UI (R12).
 */
export function useCatalogCorrection<TRequest, TEntity>({
  mutationKey,
  mutationFn,
  reload,
  revisionOf,
  entityId,
}: UseCatalogCorrectionOptions<TRequest, TEntity>): CatalogCorrection<TRequest, TEntity> {
  const [overlay, setOverlay] = useState<CorrectionOverlay<TEntity>>()
  const [confirmed, setConfirmed] = useState<TEntity>()
  const [refreshNotice, setRefreshNotice] = useState<string>()
  const token = useRef(0)
  // Guards a genuinely synchronous double submit — two `submit()` calls in
  // the SAME render/act batch, before React has had a chance to re-render
  // with `mutation.isPending === true`. `mutation.isPending` (checked below)
  // is a value captured from the LAST completed render; it does not update
  // mid-batch, so it alone cannot stop a second call landing in that same
  // batch. This ref is set synchronously the instant the first call runs.
  const submitting = useRef(false)

  const mutation = useMutation<
    TEntity,
    unknown,
    Variables<TRequest, TEntity>,
    MutateContext<TEntity>
  >({
    mutationKey,
    retry: false,
    mutationFn: ({ body }) => mutationFn(body),
    onMutate: ({ optimisticEntity }) => {
      token.current += 1
      setRefreshNotice(undefined)

      const context: MutateContext<TEntity> = { token: token.current, previousOverlay: overlay }

      setOverlay({ phase: 'optimistic', entity: optimisticEntity })

      return context
    },
    onError: (_error, _variables, context) => {
      submitting.current = false

      // A later submit already moved past this one — its own optimistic (or
      // confirmed) overlay is the current truth, and this stale failure must
      // not overwrite it.
      if (context === undefined || context.token !== token.current) return

      setOverlay(context.previousOverlay)
    },
    onSuccess: (entity, _variables, context) => {
      submitting.current = false

      if (context.token !== token.current) return

      setOverlay({ phase: 'confirmed', entity })
      setConfirmed(entity)

      void reload().then((outcome) => {
        // Superseded while the refresh was in flight: whatever comes next
        // owns reporting refresh problems now.
        if (token.current !== context.token) return

        if (outcome.status === 'error') {
          setRefreshNotice(outcome.message)
        }
      })
    },
  })

  // "Latest ref" for `mutation.reset`: the identity-change effect below must
  // call the CURRENT render's `reset` without depending on `mutation` itself
  // (a brand-new object every render, which would make that effect re-run —
  // and so clear overlay/confirmed — on every render instead of only on an
  // actual identity change). Assigning `.current` during render is what
  // `react-hooks/refs` forbids; this dep-less effect (runs after every
  // render, by design) is the documented way to keep a ref current instead.
  const resetMutationRef = useRef(mutation.reset)

  useEffect(() => {
    resetMutationRef.current = mutation.reset
  })

  // Guards against a stale overlay AND a late `onSuccess`/`onError` callback
  // from a PREVIOUS person's session, or a PREVIOUS entity (8e-3 follow-up):
  // logout, logging in as someone else, or this same component instance
  // moving on to correct a DIFFERENT Work/Translation/Edition (a client-side
  // navigation does not remount `WorkPage`) must not leave this instance
  // showing — or about to apply — someone else's/something else's catalog
  // edit. Bumping `token` here reuses the exact same staleness check
  // `onError`/`onSuccess` already do for a superseded submit — this becomes
  // stale by the same mechanism, not a second one.
  const { state: session } = useSession()
  const sessionKey = session.status === 'authenticated' ? session.user.id : session.status
  const identityKey = `${entityId} ${sessionKey}`
  const previousIdentityKey = useRef(identityKey)

  useEffect(() => {
    if (previousIdentityKey.current === identityKey) return

    previousIdentityKey.current = identityKey
    token.current += 1
    submitting.current = false
    setOverlay(undefined)
    setConfirmed(undefined)
    setRefreshNotice(undefined)
    // `mutation.status`/`.error`/`.isSuccess` (read below as `saveError` and
    // `justSaved`) are TanStack's OWN state, not React state this hook
    // manages — clearing `overlay`/`confirmed` above does not touch them.
    // Without this, a previous identity's save error/success would keep
    // showing as THIS identity's `saveError`/`justSaved`.
    resetMutationRef.current()
  }, [identityKey])

  function resolve(fresh: TEntity): TEntity {
    if (overlay === undefined) return fresh

    if (overlay.phase === 'optimistic') {
      // Not yet comparable by revision — see the doc comment on `resolve`.
      return overlay.entity
    }

    if (revisionOf(fresh) >= revisionOf(overlay.entity)) {
      // The snapshot caught up — or moved past, because someone else changed
      // this entity meanwhile. Clearing here (not just returning `fresh`) is
      // the same "adjust state during render" pattern `use-resource.ts`
      // documents: safe because this branch only runs while `overlay` is
      // still set, so it fires once per transition, not on every render.
      setOverlay(undefined)

      return fresh
    }

    return overlay.entity
  }

  return {
    overlay,
    saveError: mutation.status === 'error' ? mutation.error : undefined,
    // TanStack's own `isSuccess`, not "overlay is confirmed": `resolve()` can
    // clear the overlay the moment a (possibly very fast) refresh catches up,
    // but the save itself stays a success until the NEXT submit — a "Saved."
    // banner should not flicker off just because the background GET happened
    // to land quickly.
    justSaved: mutation.isSuccess,
    confirmed,
    refreshNotice,
    isSaving: mutation.isPending,
    submit: (body, optimisticEntity) => {
      // Defense in depth alongside the form's own `disabled` button AND the
      // `mutation.isPending` check below: a second submit while one is
      // already in flight must never become a second PATCH — not even from
      // two calls landing in the same render/act batch, before either of
      // those slower checks could possibly have caught it yet.
      if (submitting.current || mutation.isPending) return

      submitting.current = true
      mutation.mutate({ body, optimisticEntity })
    },
    dismissRefreshNotice: () => {
      setRefreshNotice(undefined)
    },
    resolve,
  }
}
