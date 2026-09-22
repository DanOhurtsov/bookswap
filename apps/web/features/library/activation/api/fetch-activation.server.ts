import 'server-only'
import { headers } from 'next/headers'
import { API_PREFIX, activationResponseSchema } from '@bookswap/shared'
import type { ActivationInitialState } from '../model/activation-state'

/**
 * Stage 8h-2, R11: the one server-side read in `apps/web`.
 *
 * Deliberately narrow — one endpoint, one function, no generic client. Every
 * other screen in this application fetches from the browser, and the checklist
 * needs the server only because R11 asks for it to be there on first paint
 * rather than after a round trip. Generalising this into an API layer would be
 * designing for callers that do not exist (§«no speculative abstractions»).
 *
 * `server-only` is not decoration: this module forwards the caller's session
 * cookie, and importing it from a client component would put that forwarding
 * into the browser bundle. The marker turns that mistake into a build error
 * instead of a leak (CONVENTIONS.md §2.4).
 *
 * The whole incoming `Cookie` header travels as it arrived. The alternative —
 * naming the session cookie here — would copy a private detail of `apps/api`
 * into `apps/web`, where nothing would notice if the API renamed it.
 *
 * Nothing here is logged. A cookie in a server log is the same credential it
 * is in a header (§9.3), and a failure is reported as a state, not as text.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export async function fetchActivationProgress(): Promise<ActivationInitialState> {
  const cookie = (await headers()).get('cookie')

  // No cookie at all is not a failed request — it is an anonymous visitor, and
  // asking the API would only spend a round trip to be told the same thing.
  if (cookie === null || cookie === '') return { status: 'guest' }

  try {
    const response = await fetch(`${API_URL}${API_PREFIX}/me/activation`, {
      // The count changes with every book added, imported or deleted; a cached
      // answer would show a checklist that is right for some earlier shelf.
      cache: 'no-store',
      headers: { cookie },
    })

    if (response.status === 401) return { status: 'guest' }
    if (!response.ok) return { status: 'error' }

    // Parsed by the shared schema, exactly as the browser parses it. An answer
    // whose fields disagree with each other (9 books, «invite friends») never
    // becomes the seed of the client cache.
    const parsed = activationResponseSchema.safeParse(await response.json())

    return parsed.success ? { status: 'ready', data: parsed.data } : { status: 'error' }
  } catch {
    // Network failure, an unreachable API, malformed JSON. The error object can
    // carry the request — cookie included — so it is not passed on or logged.
    return { status: 'error' }
  }
}
