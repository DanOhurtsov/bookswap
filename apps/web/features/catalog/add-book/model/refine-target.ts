import {
  OPEN_LIBRARY_WORK_ID_PATTERN,
  quickAddTargetSchema,
  type QuickAddEditionDetails,
  type QuickAddManualTarget,
  type QuickAddTarget,
} from '@bookswap/shared'
import { recordKeyOf } from './external-target'
import { buildManualTarget, type ManualFormValues } from './manual-form'

type ManualEdition = QuickAddManualTarget['edition']

/** The edition fields a refined record can carry as the person's details — the contract's own list. */
const DETAIL_KEYS = [
  'textKind',
  'lang',
  'isbn13',
  'publisher',
  'year',
  'pageCount',
  'format',
  'coverUrl',
] as const satisfies readonly (keyof QuickAddEditionDetails)[]

const sameValue = (one: unknown, other: unknown): boolean =>
  JSON.stringify(one) === JSON.stringify(other)

/**
 * The target of «Додати до бібліотеки» on a manual form opened from an external record (BS-114,
 * docs/plan/fast-book-add.md, §13): the record keeps its identity only while every value it supplied is
 * unchanged.
 *
 * - Title, authors and first publication year differ from the record → the person's own book (`MANUAL`),
 *   unlinked: unverified data never goes under a confirmed identity.
 * - A Google Books edition whose own values (ISBN, publisher, year, …) were changed, or whose record carries a
 *   first publication year the volume cannot confirm → the same.
 * - Otherwise the record itself (`EXTERNAL_WORK` / `EXTERNAL_EDITION`): the server takes the record's values
 *   from the source, and the request carries only what the person changed or added — for a work record, the
 *   edition is entirely theirs; a cleared cover is `null`, so the record's cover is not brought back.
 *
 * `built` is the form's target as validated; `initial` — the form as the record prefilled it.
 */
export function refineTargetOf(
  built: QuickAddManualTarget,
  initial: ManualFormValues,
  record: string | null,
): QuickAddTarget {
  const key = record === null ? undefined : recordKeyOf(record)
  const original = buildManualTarget(initial)

  if (key === undefined || 'workId' in built.work || !original.ok) return built
  if (!sameValue(built.work, original.target.work)) return built

  const isWork = key.source === 'OPEN_LIBRARY' && OPEN_LIBRARY_WORK_ID_PATTERN.test(key.externalId)
  const isEdition = key.source === 'GOOGLE_BOOKS' && key.externalId !== ''

  if (!isWork && !isEdition) return built

  // A Google Books volume confirms a title and authors only. A first publication year (merged in from a work
  // record) is not its to confirm: linking would lose it, so the form stays the person's own record.
  if (
    isEdition &&
    'firstPubYear' in original.target.work &&
    original.target.work.firstPubYear != null
  ) {
    return built
  }

  const before: ManualEdition = original.target.edition
  const after: ManualEdition = built.edition
  const changed = DETAIL_KEYS.filter((name) => !sameValue(after[name], before[name]))

  // A printing's own values are its identity: changing one makes it another book.
  if (isEdition && changed.some((name) => name !== 'textKind' && before[name] !== undefined)) {
    return built
  }

  // Checked as a whole by the contract below.
  const details = Object.fromEntries(changed.map((name) => [name, after[name] ?? null]))
  const extra = {
    ...(changed.length === 0 ? {} : { edition: details }),
    ...(built.translation === undefined ? {} : { translation: built.translation }),
  }
  const candidate = isWork
    ? { kind: 'EXTERNAL_WORK', source: 'OPEN_LIBRARY', externalId: key.externalId, ...extra }
    : {
        kind: 'EXTERNAL_EDITION',
        source: 'GOOGLE_BOOKS',
        externalId: key.externalId,
        ...(typeof before.isbn13 === 'string' ? { isbn13: before.isbn13 } : {}),
        ...extra,
      }
  const parsed = quickAddTargetSchema.safeParse(candidate)

  return parsed.success ? parsed.data : built
}
