import type { WorkAuthor, WorkPatchRequest } from '@bookswap/shared'
import { plainDataEqual } from './form-values'

/**
 * One row of the Work author editor — exactly the wire shape `PATCH
 * /works/:id` accepts per element (R10/R10a: `authorId` XOR `name`, `role`,
 * and `nameLatin` only ever alongside a new `name`). No UI-only fields live
 * here on purpose: the row's `field.value` is also what gets sent, unchanged,
 * so there is nothing to strip at submit time and no risk of the strict wire
 * schema rejecting a key the UI added for its own convenience. The
 * human-readable name for an EXISTING author (`authorId` set) is looked up by
 * id — the Work's own authors (`authorLookup`) plus candidates picked from
 * search, which `AuthorsField` keeps outside the form value.
 */
export type AuthorFormValue = NonNullable<WorkPatchRequest['authors']>[number]

export type PatchAuthors = NonNullable<WorkPatchRequest['authors']>

/** `authors` from `WorkDetailResponse` — already ordered by `position` (R10a). */
export function toAuthorFormValues(authors: readonly WorkAuthor[]): AuthorFormValue[] {
  return authors.map((author) => ({ authorId: author.id, role: author.role }))
}

export function newAuthorFormValue(): AuthorFormValue {
  return { name: '', nameLatin: null, role: 'AUTHOR' }
}

/** Same authors in the same order; key order inside an element does not matter. */
export function authorsEqual(
  a: readonly AuthorFormValue[],
  b: readonly AuthorFormValue[],
): boolean {
  return plainDataEqual(a, b)
}

/** Existing authors' current name/transliteration, looked up by id — stable across reorders. */
export function authorLookup(
  authors: readonly WorkAuthor[],
): ReadonlyMap<string, { name: string; nameLatin: string | null }> {
  return new Map(
    authors.map((author) => [author.id, { name: author.name, nameLatin: author.nameLatin }]),
  )
}
