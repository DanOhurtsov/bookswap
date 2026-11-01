import { countNoun, timeAgo } from './time-ago'

/** Local time, as the reader's calendar: `timeAgo` counts days on it. */
const local = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const iso = (time: number) => new Date(time).toISOString()

const NOW = local(30, 12)

describe('timeAgo', () => {
  it.each([
    ['30 seconds ago', NOW - 30_000, 'щойно'],
    ['a time ahead of now (another clock)', NOW + 60_000, 'щойно'],
    ['one minute ago', NOW - 60_000, '1 хв тому'],
    ['59 minutes ago', NOW - 59 * 60_000, '59 хв тому'],
    ['an hour ago', local(30, 11), '1 год тому'],
    ['at midnight today', local(30, 0), '12 год тому'],
  ])('within today: %s → %s', (_name, time, expected) => {
    expect(timeAgo(iso(time), NOW)).toBe(expected)
  })

  it('the day before is «вчора», even ten minutes ago across midnight', () => {
    expect(timeAgo(iso(local(29, 23, 50)), local(30, 0, 0))).toBe('вчора')
    expect(timeAgo(iso(local(29, 0, 5)), NOW)).toBe('вчора')
  })

  it.each([
    [2, '2 дні тому'],
    [4, '4 дні тому'],
    [5, '5 днів тому'],
    [6, '6 днів тому'],
    [7, 'тиждень тому'],
    [13, 'тиждень тому'],
    [14, '2 тижні тому'],
    [21, '3 тижні тому'],
    [29, '4 тижні тому'],
    [30, 'місяць тому'],
    [59, 'місяць тому'],
    [60, '2 місяці тому'],
    [150, '5 місяців тому'],
    [364, '12 місяців тому'],
    [365, 'рік тому'],
    [730, '2 роки тому'],
    [365 * 5 + 2, '5 років тому'],
  ])('%i calendar days back → %s', (days, expected) => {
    const added = new Date(2026, 9, 30 - days, 18).getTime()

    expect(timeAgo(iso(added), NOW)).toBe(expected)
  })
})

describe('countNoun', () => {
  it.each([
    [1, '1 запит'],
    [21, '21 запит'],
    [2, '2 запити'],
    [24, '24 запити'],
    [0, '0 запитів'],
    [5, '5 запитів'],
    [11, '11 запитів'],
    [12, '12 запитів'],
  ])('%i → %s', (n, expected) => {
    expect(countNoun(n, ['запит', 'запити', 'запитів'])).toBe(expected)
  })
})
