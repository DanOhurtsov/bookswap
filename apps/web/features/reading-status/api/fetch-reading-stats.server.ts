import 'server-only'
import { headers } from 'next/headers'
import { API_PREFIX, readingStatsResponseSchema, sessionResponseSchema } from '@bookswap/shared'
import type { ReadingStatsSnapshot } from '../model/reading-stats-view'

/**
 * BS-145: the home page's reading stats, read on the server so they are on the first paint. Built
 * like `fetchActivationProgress`: `server-only` because it forwards the caller's session cookie
 * (§2.4), the incoming `Cookie` header travels whole, nothing is cached and nothing is logged.
 *
 * Two reads, in order. The session first: it tells whose stats these are, so the browser seeds only
 * that user's cache entry with them — and a visitor whose cookie is not a session is a guest who
 * never reaches the private stats endpoint at all. Then the stats, with the same cookie, so they
 * belong to the same session (or to none, and come back as a 401).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export async function fetchReadingStatsSnapshot(): Promise<ReadingStatsSnapshot> {
  const cookie = (await headers()).get('cookie')

  // No cookie at all is an anonymous visitor, not a failed request.
  if (cookie === null || cookie === '') return { status: 'guest' }

  try {
    const session = await read('/auth/session', cookie)

    if (!session.ok) return session.snapshot

    const user = sessionResponseSchema.safeParse(session.body)

    if (!user.success) return { status: 'error' }

    const stats = await read('/me/reading-stats', cookie)

    if (!stats.ok) return stats.snapshot

    // Parsed by the shared schema, exactly as the browser parses it: a malformed answer never becomes
    // the seed of the client cache.
    const parsed = readingStatsResponseSchema.safeParse(stats.body)

    return parsed.success
      ? { status: 'ready', userId: user.data.user.id, data: parsed.data }
      : { status: 'error' }
  } catch {
    // Network failure, an unreachable API, malformed JSON. The error object can carry the request —
    // cookie included — so it is not passed on or logged.
    return { status: 'error' }
  }
}

/** A body to parse, or the snapshot the whole read ends with: 401 — a guest, anything else — an error. */
type ReadResult = { ok: true; body: unknown } | { ok: false; snapshot: ReadingStatsSnapshot }

async function read(path: string, cookie: string): Promise<ReadResult> {
  // Private and per user: never cached between requests or users.
  const response = await fetch(`${API_URL}${API_PREFIX}${path}`, {
    cache: 'no-store',
    headers: { cookie },
  })

  if (response.status === 401) return { ok: false, snapshot: { status: 'guest' } }
  if (!response.ok) return { ok: false, snapshot: { status: 'error' } }

  return { ok: true, body: await response.json() }
}
