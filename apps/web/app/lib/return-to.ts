/** Resuming one of these after signing in would only send the visitor back to signing in. */
const AUTH_PAGES: readonly string[] = ['/login', '/register']

/**
 * The invitation token lives in the fragment and must never travel inside a URL: `InviteAcceptance`
 * stashes it before login and comes back to the bare page, so nothing else of `/invite` is resumed.
 */
const INVITE_PAGE = '/invite'

/** A reserved, unreachable origin to resolve against: ending up anywhere else means another host. */
const BASE = new URL('https://bookswap.invalid')

/** C0 controls and DEL: invisible, and some of them are silently dropped by the URL parser. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)

    return code < 0x20 || code === 0x7f
  })
}

/**
 * `returnTo` comes from the address bar, so anything but a canonical address of a BookSwap page falls
 * back to `fallback` (open-redirect safe). Canonical means the URL parser would not rewrite it: what
 * it strips, resolves or reinterprets (tabs, `..`, `\`, a smuggled scheme or host) is not the address
 * that was asked for. A page that no longer exists is still a BookSwap address: it shows its own 404.
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/'): string {
  return value !== null && value !== undefined && isReturnTarget(value) ? value : fallback
}

function isReturnTarget(value: string): boolean {
  // `//host` and `/\host` are other hosts to a browser; neither is a path of ours.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  if (hasControlCharacter(value)) return false

  const url = new URL(value, BASE)

  if (url.origin !== BASE.origin || `${url.pathname}${url.search}${url.hash}` !== value)
    return false

  const page = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname

  if (page === INVITE_PAGE) return value === INVITE_PAGE

  return !AUTH_PAGES.includes(page)
}

/** `?returnTo=…` suffix for cross-links between login and register. */
export function returnToQuery(value: string | null | undefined): string {
  const safe = safeReturnTo(value, '')

  return safe === '' ? '' : `?returnTo=${encodeURIComponent(safe)}`
}

/** Where to sign in so that `target` is opened afterwards (when it may be). */
export function loginHref(target: string): string {
  return `/login${returnToQuery(target)}`
}

/** The address on screen, fragment included — which only the browser knows; never the server. */
export function currentAddress(): string {
  const { pathname, search, hash } = window.location

  return `${pathname}${search}${hash}`
}
