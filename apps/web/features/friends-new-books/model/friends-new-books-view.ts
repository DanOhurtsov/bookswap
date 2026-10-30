import type { FriendsNewBooksResponse, PublicUser } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'

/** One book a friend has added — everything the card renders, already decided. */
export interface FriendsNewBookCard {
  /** Unique per card: the feed has one card per friend and work. */
  key: string
  /** The whole card is this one link: the canonical work. */
  href: string
  /** Picks the drawn cover's colours: the work, as on every canvas shelf. */
  bookId: string
  title: string
  /** «Авторка, Автор»; empty when the work has none. */
  authors: string
  coverUrl: string | null
  /** A caption, not a link (PO decision, 30.10.2026). */
  friend: PublicUser
  /** The instant, for `<time dateTime>`. */
  addedAt: string
  /** «2 дні тому» — how long ago, counted from when the feed was read. */
  addedAgo: string
  /** The link's name: the title, the authors, who added it and when. */
  ariaLabel: string
}

export type FriendsNewBooksView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** Nothing to show — no friends, or friends who have added nothing the viewer may see. */
  | { kind: 'empty' }
  | { kind: 'ready'; cards: FriendsNewBookCard[] }

export interface FriendsNewBooksViewInput {
  data: FriendsNewBooksResponse | undefined
  error: unknown
  isError: boolean
  /** A read is under way — a manual retry after an error, say. */
  isFetching: boolean
  /** When `data` was read (ms): «тому» is counted from it, so a render never reads the clock. */
  readAt: number
}

const LOAD_FAILED = 'Не вдалося завантажити нові книжки друзів.'

/**
 * BS-147, «Нове в бібліотеках друзів». As for «Що читають мої друзі» beside it: an error is shown once
 * the read has settled, and a failed refresh hides the cards it had, so an old feed is never passed off
 * as the current one.
 */
export function toFriendsNewBooksView({
  data,
  error,
  isError,
  isFetching,
  readAt,
}: FriendsNewBooksViewInput): FriendsNewBooksView {
  if (isError && !isFetching) {
    return { kind: 'error', message: `${LOAD_FAILED} ${describeError(error)}`.trim() }
  }
  if (data === undefined || isError) return { kind: 'loading' }
  if (data.items.length === 0) return { kind: 'empty' }

  return {
    kind: 'ready',
    cards: data.items.map((item) => {
      const authors = item.authors.map((author) => author.name).join(', ')
      const addedAgo = timeAgo(item.addedAt, readAt)

      return {
        key: `${item.friend.id}:${item.work.id}`,
        href: `/works/${encodeURIComponent(item.work.id)}`,
        bookId: item.work.id,
        title: item.work.title,
        authors,
        coverUrl: item.coverUrl,
        friend: item.friend,
        addedAt: item.addedAt,
        addedAgo,
        ariaLabel:
          [item.work.title, authors].filter((part) => part !== '').join(', ') +
          `. Додано: ${item.friend.displayName}, ${addedAgo}`,
      }
    }),
  }
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const PLURAL = new Intl.PluralRules('uk-UA')

/** «3 дні»: Ukrainian one (1, 21), few (2–4, 22–24) and many (0, 5–20, 25…) forms. */
function count(n: number, [one, few, many]: readonly [string, string, string]): string {
  const form = PLURAL.select(n)

  return `${String(n)} ${form === 'one' ? one : form === 'few' ? few : many}`
}

/** Local midnight of the day `time` falls on. */
function dayOf(time: number): number {
  const date = new Date(time)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * How long ago `iso` was, seen from `now`, in the reader's own calendar: within today in minutes and
 * hours, «вчора» for the day before — even if that was ten minutes ago, past midnight — then days, weeks,
 * months and years. Rounded down, so it never says more time has passed than has. A time ahead of `now`
 * (another clock) is «щойно».
 */
export function timeAgo(iso: string, now: number): string {
  const time = Date.parse(iso)
  const elapsed = now - time

  if (elapsed < MINUTE_MS) return 'щойно'

  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const days = Math.round((dayOf(now) - dayOf(time)) / DAY_MS)

  if (days === 0) {
    return elapsed < HOUR_MS
      ? `${String(Math.floor(elapsed / MINUTE_MS))} хв тому`
      : `${String(Math.floor(elapsed / HOUR_MS))} год тому`
  }
  if (days === 1) return 'вчора'
  if (days < 7) return `${count(days, ['день', 'дні', 'днів'])} тому`
  if (days < 14) return 'тиждень тому'
  if (days < 30) return `${count(Math.floor(days / 7), ['тиждень', 'тижні', 'тижнів'])} тому`
  if (days < 60) return 'місяць тому'
  if (days < 365) return `${count(Math.floor(days / 30), ['місяць', 'місяці', 'місяців'])} тому`
  if (days < 730) return 'рік тому'

  return `${count(Math.floor(days / 365), ['рік', 'роки', 'років'])} тому`
}
