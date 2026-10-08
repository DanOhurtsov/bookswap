import type { AddSearchEditionItem } from '@bookswap/shared'

/** Identity of an edition known by its ISBN-13. The format is shared with `externalIdentities`. */
export function isbnIdentity(isbn13: string): string {
  return `isbn:${isbn13}`
}

/** Identities of an edition: all of them point to one add slot (see `QuickAddSlot`). */
export function identitiesOf(item: {
  edition: Pick<AddSearchEditionItem['edition'], 'id' | 'isbn13'>
}): string[] {
  return [
    `edition:${item.edition.id}`,
    ...(item.edition.isbn13 === null ? [] : [isbnIdentity(item.edition.isbn13)]),
  ]
}
