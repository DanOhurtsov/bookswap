/*
 * BS-147: how long ago, in words — the home page's sections say when a friend added a book and when a
 * request came.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const PLURAL = new Intl.PluralRules('uk-UA')

/** «3 дні»: Ukrainian one (1, 21), few (2–4, 22–24) and many (0, 5–20, 25…) forms. */
export function countNoun(n: number, [one, few, many]: readonly [string, string, string]): string {
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
  if (days < 7) return `${countNoun(days, ['день', 'дні', 'днів'])} тому`
  if (days < 14) return 'тиждень тому'
  if (days < 30) return `${countNoun(Math.floor(days / 7), ['тиждень', 'тижні', 'тижнів'])} тому`
  if (days < 60) return 'місяць тому'
  if (days < 365) return `${countNoun(Math.floor(days / 30), ['місяць', 'місяці', 'місяців'])} тому`
  if (days < 730) return 'рік тому'

  return `${countNoun(Math.floor(days / 365), ['рік', 'роки', 'років'])} тому`
}
