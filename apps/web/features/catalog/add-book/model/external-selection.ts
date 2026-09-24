import {
  externalSearchResultToLookup,
  type ExternalSearchResult,
  type Translation,
} from '@bookswap/shared'
import type { DuplicateCheck } from '../api/search-external'
import type { ExistingWorkInput, NewWorkInput } from './add-book-step'

/**
 * What happens after the user picks an external record.
 *
 * There is deliberately no "no duplicates found" state: in that case there is
 * nothing to show, and the step moves straight to the creation form
 * (`SearchStep`). The panel appears only when it has something to say.
 */
export type ExternalSelection =
  | { status: 'checking'; result: ExternalSearchResult }
  | { status: 'failed'; result: ExternalSearchResult; message: string }
  | { status: 'duplicates'; result: ExternalSearchResult; check: DuplicateCheck }

/**
 * An external record → the input for the "create a new work" step.
 *
 * `isbn` is taken ONLY from `result.isbn13`, i.e. only when the source named
 * the ISBN of this very edition. A work record (`kind: 'WORK'`) has none by
 * definition, and leaving the field empty is right: the user copies the ISBN
 * off their own book, whereas a plausible-looking substituted one would most
 * likely go unnoticed and be confirmed.
 *
 * `firstPubYear` comes from `firstPublishedYear` and from nowhere else. That
 * field is work-level by contract, so it is the only one that may reach
 * `Work.firstPubYear`; `publishedYear` is the year of one printing and must
 * never end up there. It travels beside `lookup` rather than inside it because
 * `BookLookupResult` describes an edition, and every year in that shape means
 * `Edition.year` — see `app/lib/lookup-mapping.ts`.
 */
export function newWorkFromExternal(
  result: ExternalSearchResult,
  entryMethod: NewWorkInput['entryMethod'],
): NewWorkInput {
  return {
    initialTitle: result.title,
    entryMethod,
    lookup: externalSearchResultToLookup(result),
    ...(result.isbn13 === undefined ? {} : { isbn: result.isbn13 }),
    ...(result.firstPublishedYear === undefined ? {} : { firstPubYear: result.firstPublishedYear }),
  }
}

/**
 * The same, for a work that already exists: the metadata becomes a draft for
 * `Translation`/`Edition`.
 *
 * `existingTranslations` is forwarded exactly as the local path does
 * (`SearchResults.tsx`). Without it `TranslationStep` renders no list of the
 * work's existing translations, and the user creates a second `Translation` for
 * a language the work already has — the very duplicate §6.3 step 2 exists to
 * prevent. `firstPubYear` is absent on purpose: the work is already in the
 * catalog, and this path does not re-edit it.
 */
export function existingWorkFromExternal(
  workId: string,
  title: string,
  result: ExternalSearchResult,
  entryMethod: ExistingWorkInput['entryMethod'],
  existingTranslations: Translation[],
): ExistingWorkInput {
  return {
    workId,
    title,
    entryMethod,
    existingTranslations,
    lookup: externalSearchResultToLookup(result),
    ...(result.isbn13 === undefined ? {} : { isbn: result.isbn13 }),
  }
}
