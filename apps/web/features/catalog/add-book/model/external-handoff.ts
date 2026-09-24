'use client'

import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { externalSearchResultSchema, type ExternalSearchResult } from '@bookswap/shared'

const STORAGE_KEY = 'bookswap.add-book.external-selection'

/**
 * How long a handover stays usable.
 *
 * Session storage outlives the navigation that filled it — it survives
 * reloads and stays until the tab closes — so without a bound a choice made
 * this morning could still be sitting there this afternoon. An hour is the same
 * horizon the server keeps external search results for, past which the record
 * would be re-fetched anyway.
 */
const HANDOFF_TTL_MS = 60 * 60_000

/**
 * Carrying ONE chosen external record from `/catalog` into the add-book wizard.
 *
 * `sessionStorage` rather than the URL, and that is a decision about what a
 * link means. The record is a whole book description — title, authors, ISBN,
 * publisher, cover — which no query string should carry; and a URL that carried
 * it would be shareable, so opening someone else's link would silently resume a
 * selection the recipient never made. Session storage is scoped to the one tab
 * that made the choice.
 *
 * **The stored record is bound to ONE navigation by a token.** Storage holds at
 * most one record while the address bar can name any number of handovers, so
 * "there is something stored and the URL says `external`" is not evidence that
 * the two belong together: choosing book A and then opening the wizard for a
 * different handover would open A's form. The token is minted when the record
 * is stored, travels in the URL, and must match before anything is resumed.
 *
 * Matching the titles instead would not do: two printings of one book carry the
 * same title, so a title match cannot tell the chosen edition from another one.
 * The token identifies the ACT of choosing, not the book.
 *
 * Reading is defensive at every step. Storage can be absent or throw outright
 * (server rendering, private browsing, blocked site data), the value can be
 * anything at all, and a record that is missing, stale, corrupt or bound to a
 * different navigation is discarded rather than trusted: the wizard then shows
 * its normal search for the query in the URL, which is what it did before this
 * path existed.
 */
const handoffSchema = z.object({
  /** Identifies this handover; also present in the URL that follows it. */
  token: z.string().min(1),
  /** The `?q=` the choice was made under; the destination must carry the same. */
  query: z.string(),
  savedAt: z.number().int().positive(),
  result: externalSearchResultSchema,
})

type Handoff = z.infer<typeof handoffSchema>

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Bumped whenever the stored record changes.
 *
 * `getSnapshot` must return a stable REFERENCE for unchanged state or React
 * re-renders forever, and our value is an object. So the parsed record is
 * cached against this counter instead of being re-parsed on every render.
 */
let version = 0
let cached: { version: number; value: Handoff | undefined } | undefined

/**
 * A token for one handover.
 *
 * Not a secret and not a security boundary — it never leaves the tab that
 * minted it, and it guards against confusing two of the person's OWN
 * navigations, not against an attacker. `randomUUID` where it exists, and a
 * timestamp plus randomness where it does not (older browsers, some test
 * environments); either is far beyond enough to tell two clicks apart.
 */
function mintToken(): string {
  const source = globalThis.crypto

  if (typeof source?.randomUUID === 'function') return source.randomUUID()

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function readStoredHandoff(): Handoff | undefined {
  let raw: string | null

  try {
    raw = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }

  if (raw === null) return undefined

  let parsed: Handoff

  try {
    const candidate = handoffSchema.safeParse(JSON.parse(raw))

    if (!candidate.success) return undefined

    parsed = candidate.data
  } catch {
    return undefined
  }

  // Freshness is judged once, when the value is read, rather than on every
  // render: a handover that was valid when the wizard opened must not expire
  // out from under a form the person is filling in.
  return Date.now() - parsed.savedAt > HANDOFF_TTL_MS ? undefined : parsed
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Handoff | undefined {
  if (cached === undefined || cached.version !== version) {
    cached = { version, value: readStoredHandoff() }
  }

  return cached.value
}

/** Nothing has been chosen while rendering on the server. */
function getServerSnapshot(): undefined {
  return undefined
}

/**
 * Remembers the record the person picked and returns the token that names this
 * handover. `undefined` when storage refused it — the caller then links to the
 * wizard without a token, and it opens its ordinary search.
 */
export function stashExternalSelection(
  result: ExternalSearchResult,
  query: string,
): string | undefined {
  const handoff: Handoff = { token: mintToken(), query, savedAt: Date.now(), result }

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff))
  } catch {
    return undefined
  }

  version += 1

  for (const listener of listeners) listener()

  return handoff.token
}

/**
 * The record to resume with, or `undefined`.
 *
 * `useSyncExternalStore` rather than an effect that sets state: session storage
 * is state living outside React, this is the hook built for reading exactly
 * that, and it is the same mechanism `ThemeSwitcher` already uses for
 * `localStorage`. It also carries a server snapshot, so the value being absent
 * during server rendering is part of the contract instead of a hydration
 * accident.
 *
 * Nothing is resumed unless the URL's token and query BOTH match what was
 * stored. The address stays the thing that decides, and it decides for one
 * specific handover: back and forward still work, because a URL that named a
 * valid handover keeps naming it, while a URL naming some other one resumes
 * nothing.
 */
export function useExternalSelectionHandoff(
  token: string | null,
  query: string,
): ExternalSearchResult | undefined {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  if (token === null || stored === undefined) return undefined

  return stored.token === token && stored.query === query ? stored.result : undefined
}
