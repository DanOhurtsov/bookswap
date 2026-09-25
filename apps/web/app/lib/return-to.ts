/** Only pages that are meant to be resumed after login/register. */
const ALLOWED_RETURN_TO = ['/invite'] as const

/**
 * `returnTo` comes from the address bar, so it is an allowlist, not a sanitiser:
 * anything but an exact match falls back to `fallback` (open-redirect safe).
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/profile'): string {
  return ALLOWED_RETURN_TO.find((allowed) => allowed === value) ?? fallback
}

/** `?returnTo=…` suffix for cross-links between login and register. */
export function returnToQuery(value: string | null | undefined): string {
  const safe = safeReturnTo(value, '')

  return safe === '' ? '' : `?returnTo=${encodeURIComponent(safe)}`
}
