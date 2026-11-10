import { countNoun } from '@/app/lib/time-ago'

/**
 * The return date of a request or an approval, as the canvas picks it: four presets, «Своя дата» and a
 * month calendar. Every value here is a calendar day, `YYYY-MM-DD` — what the contract sends (`dueAt`,
 * `proposedDueAt`, §8) — never an instant: a preset is «today plus N days» in the reader's calendar and
 * nothing more. No term is counted from a handover; the server has no such rule.
 *
 * Day arithmetic goes through UTC dates, so a daylight-saving shift can never move a day.
 */

/** A calendar day, `2026-11-30`. An empty string is «no date». */
export type Day = string

export const NO_DAY: Day = ''

/** The canvas's presets, in days. «Місяць» is 30 days: the contract's longest default term. */
export const LOAN_TERM_PRESETS = [
  { days: 7, label: 'Тиждень' },
  { days: 14, label: '2 тижні' },
  { days: 21, label: '3 тижні' },
  { days: 30, label: 'Місяць' },
] as const

const CUSTOM_TERM = 'custom'
const NO_TERM = 'none'

const MONTH_NAMES = [
  'Січень',
  'Лютий',
  'Березень',
  'Квітень',
  'Травень',
  'Червень',
  'Липень',
  'Серпень',
  'Вересень',
  'Жовтень',
  'Листопад',
  'Грудень',
] as const

const DAY_MS = 86_400_000

/** The day `date` falls on in the reader's own calendar. */
export function localDay(date: Date): Day {
  return dayOfUtc(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
}

export function addDays(day: Day, days: number): Day {
  return dayOfUtc(utcOf(day) + days * DAY_MS)
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS)
}

/** «2026-11-15» → «15.11.26», as the canvas writes a return date. */
export function shortDay(day: Day): string {
  const [year = '', month = '', date = ''] = day.split('-')

  return `${date}.${month}.${year.slice(2)}`
}

/** «через 3 тижні», «через 26 днів» — how far the date is from today, nothing about a handover. */
export function termFromToday(today: Day, due: Day): string {
  const days = daysBetween(today, due)

  if (days < 0) return 'Ця дата вже минула'
  if (days === 0) return 'Сьогодні'
  if (days % 7 === 0) return `Через ${countNoun(days / 7, ['тиждень', 'тижні', 'тижнів'])}`

  return `Через ${countNoun(days, ['день', 'дні', 'днів'])}`
}

/** The first day a return can be set to: a book borrowed today goes back tomorrow at the earliest. */
export function firstDueDay(today: Day): Day {
  return addDays(today, 1)
}

export type TermOption = {
  key: string
  label: string
  /** «до 16.11.26», «за запитом», «у календарі». */
  hint: string
  isChecked: boolean
  /** The date a preset sets (`NO_DAY` for «Без дати»); `null` for «Своя дата», which only opens the calendar. */
  day: Day | null
}

export type TermOptionsInput = {
  today: Day
  value: Day
  /** «Своя дата» was chosen: it stays checked even when the picked day equals a preset's. */
  isCustom: boolean
  /** The borrower's date, on the owner's side: its preset says «за запитом». */
  requested?: Day | null
  /** Sending no date means something here: «Без дати» is an option of its own, the first one. */
  canClear?: boolean
}

/**
 * The options of the radio group: «Без дати» where it may be chosen, the presets, «Своя дата». At most
 * one is checked; without «Без дати», none while no date is chosen.
 */
export function termOptionsOf({
  today,
  value,
  isCustom,
  requested = null,
  canClear = false,
}: TermOptionsInput) {
  const matched = isCustom
    ? undefined
    : LOAN_TERM_PRESETS.find(({ days }) => addDays(today, days) === value)
  const presets: TermOption[] = LOAN_TERM_PRESETS.map(({ days, label }) => {
    const day = addDays(today, days)

    return {
      key: String(days),
      label,
      hint: day === requested ? 'за запитом' : `до ${shortDay(day)}`,
      isChecked: matched?.days === days,
      day,
    }
  })
  const isCustomChecked = matched === undefined && (isCustom || value !== NO_DAY)

  const none: TermOption = {
    key: NO_TERM,
    label: 'Без дати',
    hint: 'без терміну',
    isChecked: !isCustom && value === NO_DAY,
    day: NO_DAY,
  }

  return [
    ...(canClear ? [none] : []),
    ...presets,
    {
      key: CUSTOM_TERM,
      label: 'Своя дата',
      hint: isCustomChecked && value !== NO_DAY ? `до ${shortDay(value)}` : 'у календарі',
      isChecked: isCustomChecked,
      day: null,
    },
  ]
}

/** A month of the calendar: its year and its month, 0-based like `Date`. */
export type Month = { year: number; month: number }

export function monthOf(day: Day): Month {
  const [year = 0, month = 1] = day.split('-').map(Number)

  return { year, month: month - 1 }
}

export function shiftMonth({ year, month }: Month, by: number): Month {
  const index = year * 12 + month + by

  return { year: Math.floor(index / 12), month: index % 12 }
}

function monthIndex({ year, month }: Month): number {
  return year * 12 + month
}

export type CalendarDay = {
  day: Day
  /** The day of the month, for the cell. */
  date: number
  /** «30.11.26, сьогодні, обрана дата повернення» — what a screen reader hears. */
  label: string
  isToday: boolean
  isSelected: boolean
  /** Between today and the chosen date: the canvas tints the term. */
  isInTerm: boolean
  isDisabled: boolean
}

export type CalendarMonth = {
  title: string
  /** Seven cells a row, Monday first; `null` before the first day. */
  cells: (CalendarDay | null)[]
  canGoBack: boolean
}

export type CalendarInput = { shown: Month; today: Day; value: Day }

/** One month as the grid draws it. Days before `firstDueDay` are shown but cannot be picked. */
export function calendarMonthOf({ shown, today, value }: CalendarInput): CalendarMonth {
  const first = Date.UTC(shown.year, shown.month, 1)
  const length = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate()
  const lead = (new Date(first).getUTCDay() + 6) % 7
  const earliest = firstDueDay(today)
  const cells: (CalendarDay | null)[] = Array.from({ length: lead }, () => null)

  for (let date = 1; date <= length; date++) {
    const day = dayOfUtc(Date.UTC(shown.year, shown.month, date))
    const isToday = day === today
    const isSelected = day === value

    cells.push({
      day,
      date,
      label: [shortDay(day), isToday ? 'сьогодні' : null, isSelected ? 'обрана дата' : null]
        .filter((part) => part !== null)
        .join(', '),
      isToday,
      isSelected,
      isInTerm: value !== NO_DAY && day > today && day < value,
      isDisabled: day < earliest,
    })
  }

  return {
    title: `${MONTH_NAMES[shown.month] ?? ''} ${String(shown.year)}`,
    cells,
    canGoBack: monthIndex(shown) > monthIndex(monthOf(today)),
  }
}

/** The arrow keys of the grid (the APG date picker): a day, a week, the week's ends, a month. */
export function movedDay(day: Day, key: string): Day | null {
  const weekday = (new Date(utcOf(day)).getUTCDay() + 6) % 7

  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1)
    case 'ArrowRight':
      return addDays(day, 1)
    case 'ArrowUp':
      return addDays(day, -7)
    case 'ArrowDown':
      return addDays(day, 7)
    case 'Home':
      return addDays(day, -weekday)
    case 'End':
      return addDays(day, 6 - weekday)
    case 'PageUp':
      return sameDateIn(day, -1)
    case 'PageDown':
      return sameDateIn(day, 1)
    default:
      return null
  }
}

/** The same date a month away, or that month's last day when it is shorter (31.01 → 28.02). */
function sameDateIn(day: Day, by: number): Day {
  const target = shiftMonth(monthOf(day), by)
  const length = new Date(Date.UTC(target.year, target.month + 1, 0)).getUTCDate()
  const date = Math.min(Number(day.slice(8)), length)

  return dayOfUtc(Date.UTC(target.year, target.month, date))
}

function utcOf(day: Day): number {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)

  return Date.UTC(year, month - 1, date)
}

function dayOfUtc(time: number): Day {
  return new Date(time).toISOString().slice(0, 10)
}
