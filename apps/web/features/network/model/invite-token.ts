import { INVITATION_TOKEN_MAX } from '@bookswap/shared'

const STORAGE_KEY = 'bookswap.invite-token'

/** The token travels in the URL fragment: it never reaches server logs or `Referer`. */
export function tokenFromHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash

  if (raw === '') return undefined

  try {
    const token = decodeURIComponent(raw)

    return token.length > 0 && token.length <= INVITATION_TOKEN_MAX ? token : undefined
  } catch {
    return undefined
  }
}

// Storage can be missing or throw (private mode, blocked site data): the flow then
// only loses "resume after login", which the invitee can redo from the link.
export function stashInviteToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // see above
  }
}

export function readStashedInviteToken(): string | undefined {
  try {
    const token = window.sessionStorage.getItem(STORAGE_KEY)

    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

export function clearStashedInviteToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // see above
  }
}
