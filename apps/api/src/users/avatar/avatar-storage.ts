/**
 * BS-148: where profile photos live. `AVATAR_STORAGE` picks the implementation (`UsersModule`):
 * `R2AvatarStorage` in production, `InMemoryAvatarStorage` for tests and development without keys.
 *
 * The storage knows nothing about users: it keeps bytes under a key and says at which public address
 * the browser loads them. Which key belongs to whom is `AvatarService`'s business.
 */
export interface AvatarStorage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  /** Deleting a key that is not there is not an error: a photo is removed best-effort. */
  delete(key: string): Promise<void>
  /** The public address of a stored photo — what `User.avatarUrl` holds. */
  urlFor(key: string): string
  /**
   * The key behind one of this storage's own addresses, `null` for any other address. An avatar
   * URL set before BS-148 points somewhere else entirely and must never be "deleted" here.
   */
  keyFor(url: string): string | null
}

/** DI token: a TypeScript interface does not exist at runtime. */
export const AVATAR_STORAGE = 'AVATAR_STORAGE'

/** `urlFor`/`keyFor` for a storage whose every photo sits directly under one base address. */
export function keyUnder(baseUrl: string, url: string): string | null {
  const prefix = `${baseUrl}/`

  return url.startsWith(prefix) && url.length > prefix.length ? url.slice(prefix.length) : null
}
