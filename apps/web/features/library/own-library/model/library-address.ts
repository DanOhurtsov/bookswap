import { libraryQueryRequestSchema, type LibraryQueryRequest } from '@bookswap/shared'
import type { LibraryView } from '@/app/lib/use-library'

/**
 * What the address of `/library` says: which view is open and, in the own view, the filters.
 * `?view=archive` is also a direct link from the add-book results to the restore scenario.
 */
export interface LibraryAddress {
  view: LibraryView
  filters: LibraryQueryRequest
}

export const LIBRARY_PATH = '/library'

/**
 * The owner's page of one copy: `/library/:copyId`. It is the id of the `Copy`, never of the edition
 * or the work: a shelf card groups the owner's copies of one edition, and each of them has its own
 * page (its own note, its own state).
 */
export function libraryBookHref(copyId: string): string {
  return `${LIBRARY_PATH}/${encodeURIComponent(copyId)}`
}

const LIBRARY_VIEWS: readonly LibraryView[] = ['own', 'out', 'borrowed', 'archive']

/** The filters that live in the address: the same names as the API takes them under. */
const FILTER_KEYS = ['status', 'lang', 'q'] as const

const filtersSchema = libraryQueryRequestSchema.pick({ status: true, lang: true, q: true })

export function isLibraryView(value: string): value is LibraryView {
  return (LIBRARY_VIEWS as readonly string[]).includes(value)
}

/**
 * The address as the screen reads it. Nothing in the address is an error: a missing `view` is the own
 * view, and anything unreadable falls back to the default and is reported through `valid: false`, so
 * the screen can correct the address instead of showing one thing under another.
 *
 * Only the own view has filters; in the other views they are not read.
 */
export function readLibraryAddress(
  parameters: URLSearchParams,
): LibraryAddress & { valid: boolean } {
  const rawView = parameters.get('view') ?? ''

  if (rawView !== '' && !isLibraryView(rawView)) return { view: 'own', filters: {}, valid: false }

  const view: LibraryView = isLibraryView(rawView) ? rawView : 'own'

  if (view !== 'own') return { view, filters: {}, valid: true }

  const parsed = filtersSchema.safeParse({
    status: parameters.get('status') ?? undefined,
    lang: parameters.get('lang') ?? undefined,
    q: parameters.get('q') ?? undefined,
  })

  return parsed.success
    ? { view, filters: parsed.data, valid: true }
    : { view, filters: {}, valid: false }
}

/** The filters on their own, as a string: equal filters give equal keys. */
export function filtersKey(filters: LibraryQueryRequest): string {
  const parameters = new URLSearchParams()

  for (const key of FILTER_KEYS) {
    const value = filters[key]

    if (value !== undefined) parameters.set(key, value)
  }

  return parameters.toString()
}

/** The canonical address: the own view without filters is `/library` with nothing after it. */
export function libraryHref({ view, filters }: LibraryAddress): string {
  const query = view === 'own' ? filtersKey(filters) : new URLSearchParams({ view }).toString()

  return query === '' ? LIBRARY_PATH : `${LIBRARY_PATH}?${query}`
}
