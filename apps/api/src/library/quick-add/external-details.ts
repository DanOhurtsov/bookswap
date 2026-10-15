import {
  CATALOG_LIMITS,
  type QuickAddEditionDetails,
  type QuickAddExternalWorkTarget,
  type QuickAddManualTarget,
} from '@bookswap/shared'
import type { ConfirmedExternalEdition } from './external-edition.resolver'
import type { KnownExternalWork } from './external-work.resolver'

/**
 * What the source confirmed plus what the person added in «Уточнити дані» (BS-114) — decided here, written by
 * `CatalogChainWriter`. The rule throughout: a value the source reported is never overridden by the client,
 * and a value nobody reported stays unknown.
 */

type ManualEdition = QuickAddManualTarget['edition']

/** A value outside the catalog's bounds is "unknown", not a clipped number. */
export function inRange(value: number | undefined, min: number, max: number): number | null {
  return value !== undefined && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

/** A source's cover that does not fit the catalog's limit is unknown, not a truncated link. */
export function sourceCover(url: string | undefined): string | null {
  return url !== undefined && url.length <= CATALOG_LIMITS.coverUrlMax ? url : null
}

/**
 * The language of an edition the person EXPLICITLY called the original is the work's original language; in
 * every other case the work's language stays unknown.
 */
export function originalLanguageOf(
  edition: Pick<ManualEdition, 'textKind' | 'lang'>,
): string | null {
  return edition.textKind === 'ORIGINAL' ? (edition.lang ?? null) : null
}

/** A refined external EDITION: every field the source reported wins; the person's details only fill gaps. */
export function editionFromSource(
  confirmed: ConfirmedExternalEdition,
  details: QuickAddEditionDetails | undefined,
): ManualEdition {
  const { metadata } = confirmed
  const added = details ?? {}

  return {
    textKind: added.textKind ?? 'UNKNOWN',
    lang: metadata.language ?? added.lang ?? null,
    publisher: metadata.publisher?.slice(0, CATALOG_LIMITS.publisherMax) ?? added.publisher ?? null,
    year:
      inRange(metadata.publishedYear, CATALOG_LIMITS.yearMin, CATALOG_LIMITS.yearMax) ??
      added.year ??
      null,
    isbn13: confirmed.isbn13 ?? added.isbn13 ?? null,
    pageCount:
      inRange(metadata.pageCount, 1, CATALOG_LIMITS.pageCountMax) ?? added.pageCount ?? null,
    format: metadata.format ?? added.format ?? null,
    coverUrl: sourceCover(metadata.coverUrl) ?? added.coverUrl ?? null,
  }
}

/**
 * A refined WORK record: the record describes no edition, so the edition is the person's. Only the cover the
 * card showed is the record's — kept unless the person replaced it or cleared it (`null`).
 */
export function editionOfWorkRecord(
  details: QuickAddEditionDetails | undefined,
  recordCover: string | undefined,
): ManualEdition {
  const added = details ?? {}

  return {
    ...added,
    textKind: added.textKind ?? 'UNKNOWN',
    coverUrl: added.coverUrl === undefined ? sourceCover(recordCover) : added.coverUrl,
  }
}

/**
 * Whether adding this work record needs the source's answer: to create our work, to give a direct add its
 * unspecified edition, or to give a refined edition the record's cover. A direct add of a record whose edition
 * already exists needs nothing — it works with the provider down.
 */
export function needsWorkSource(
  target: Pick<QuickAddExternalWorkTarget, 'edition' | 'translation'>,
  known: KnownExternalWork | null,
): boolean {
  if (known === null) return true

  if (target.edition === undefined && target.translation === undefined) {
    return known.editionId === null
  }

  return target.edition?.coverUrl === undefined
}
