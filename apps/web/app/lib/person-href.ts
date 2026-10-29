import type { PublicUser } from '@bookswap/shared'

/**
 * BS-148: a person's address is `/u/<handle>`. Every link to a person is built here and nowhere
 * else, so the address is one decision, not one per screen.
 */
export function personHref(person: Pick<PublicUser, 'handle'>): string {
  return `/u/${encodeURIComponent(person.handle)}`
}
