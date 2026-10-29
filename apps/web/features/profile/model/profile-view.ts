import type {
  Me,
  ProfileActivity,
  ProfileBookPlace,
  ProfileCounterpart,
  ProfileSummary,
  PublicUser,
} from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { personHref } from '@/app/lib/person-href'

/**
 * BS-148, sub-stage F: what the profile page says, decided in one place. Components render these
 * values and decide nothing — every wording, link and tone here has a unit test.
 */

const LOCALE = 'uk-UA'

/** Ukrainian plural forms: one (1, 21), few (2–4, 22–24), many (0, 5–20, 25…). */
export function pluralUk(
  count: number,
  [one, few, many]: readonly [string, string, string],
): string {
  const lastTwo = count % 100
  const last = count % 10

  if (lastTwo >= 11 && lastTwo <= 14) return many
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few

  return many
}

/**
 * «@marta · Вроцлав»; no city, no city part. The join date is not on it (PO decision, 28.10.2026): it
 * said little and added noise.
 */
export function profileMetaLine(user: Pick<Me, 'handle' | 'city'>): string {
  return [`@${user.handle}`, user.city].filter((part) => part !== null).join(' · ')
}

/**
 * «22 жовт.»; a date of another year than `now` keeps its year. A calendar day (`2026-11-02`) and an
 * instant are both read in UTC: the API sends due days as dates, and an instant one hour from
 * midnight must not move to the next day for a reader west of Greenwich.
 */
export function shortDate(iso: string, now: Date): string {
  const date = new Date(iso)
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear()

  return date.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  })
}

/** A guest is named as the owner wrote them down; once that is erased — just «гість». */
export function counterpartName(counterpart: ProfileCounterpart): string {
  return counterpart.kind === 'USER' ? counterpart.user.displayName : (counterpart.alias ?? 'гість')
}

// --- Books --------------------------------------------------------------------

/** The dot and text colour under a cover. The text says the same — colour only repeats it. */
export type PlaceTone = 'home' | 'requested' | 'out' | 'overdue' | 'muted'

export interface PlaceLabel {
  text: string
  tone: PlaceTone
}

/** Holder names follow the app's «у Марта» (see `PersonLibrary`): names are never declined. */
export function placeLabel(place: ProfileBookPlace, now: Date): PlaceLabel {
  switch (place.kind) {
    case 'HOME':
      return { text: 'Вдома', tone: 'home' }
    case 'HOME_REQUESTED':
      return {
        text:
          place.pendingRequestCount === 1
            ? 'Вдома · є запит'
            : `Вдома · ${String(place.pendingRequestCount)} ${pluralUk(place.pendingRequestCount, ['запит', 'запити', 'запитів'])}`,
        tone: 'requested',
      }
    case 'RESERVED':
      return { text: `Чекає передачі · ${counterpartName(place.borrower)}`, tone: 'requested' }
    case 'UNAVAILABLE':
      return { text: 'Не позичається', tone: 'muted' }
    case 'LENT': {
      const holder = `У ${counterpartName(place.holder)}`

      if (place.overdue) return { text: `${holder} · прострочено`, tone: 'overdue' }
      if (place.dueAt === null) return { text: holder, tone: 'out' }

      return { text: `${holder} до ${shortDate(place.dueAt, now)}`, tone: 'out' }
    }
    case 'LOST':
      return { text: `Втрачено · ${counterpartName(place.holder)}`, tone: 'overdue' }
  }
}

export interface ProfileBookCard {
  key: string
  /** The work: a drawn cover takes its colours from it, so one book is one colour everywhere. */
  bookId: string
  title: string
  authors: string
  coverUrl: string | null
  href: string
  place: PlaceLabel
  /** The card is one link: its name says the title, the authors and where the copy is. */
  ariaLabel: string
}

// --- Activity -----------------------------------------------------------------

/** The icon of an activity line; `action` waits for me. */
export type ActivityTone = 'action' | 'positive' | 'out' | 'neutral'

export interface ActivityLine {
  key: string
  text: string
  when: string
  href: string
  icon: 'request' | 'approved' | 'rejected' | 'handed' | 'returned' | 'added'
  tone: ActivityTone
}

type LoanActivity = Extract<ProfileActivity, { kind: 'LOAN' }>

/**
 * Names and titles are never declined, and a person's gender is unknown, so every line keeps the
 * name in the nominative (as «у Марта» elsewhere) and a title behind «книжка» (PO decision,
 * 27.10.2026).
 */
function loanText(line: LoanActivity): string {
  const name = counterpartName(line.counterpart)
  const book = `«${line.work.title}»`

  if (line.role === 'OWNER') {
    switch (line.event) {
      case 'REQUESTED':
        return `${name} просить книжку ${book}`
      case 'APPROVED':
        return `Ви погодили запит на книжку ${book} від ${name}`
      case 'REJECTED':
        return `Ви відхилили запит на книжку ${book} від ${name}`
      case 'HANDED_OVER':
        return `Книжка ${book} тепер у ${name}`
      case 'RETURNED':
        return `Книжка ${book} повернулася від ${name}`
    }
  }

  switch (line.event) {
    case 'REQUESTED':
      return `Ви попросили книжку ${book} у ${name}`
    case 'APPROVED':
      return `${name} погоджує ваш запит на книжку ${book}`
    case 'REJECTED':
      return `${name} відхиляє ваш запит на книжку ${book}`
    case 'HANDED_OVER':
      return `Книжка ${book} тепер у вас`
    case 'RETURNED':
      return `Ви повернули книжку ${book}`
  }
}

const LOAN_ICON: Record<LoanActivity['event'], ActivityLine['icon']> = {
  REQUESTED: 'request',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  HANDED_OVER: 'handed',
  RETURNED: 'returned',
}

function loanTone(line: LoanActivity): ActivityTone {
  switch (line.event) {
    // A request to me waits for my answer; my own request waits for someone else.
    case 'REQUESTED':
      return line.role === 'OWNER' ? 'action' : 'neutral'
    case 'APPROVED':
    case 'RETURNED':
      return 'positive'
    case 'HANDED_OVER':
      return 'out'
    case 'REJECTED':
      return 'neutral'
  }
}

/** A guest loan is opened on its own owner-only page (as in notifications). */
function loanHref(line: LoanActivity): string {
  const path = line.counterpart.kind === 'GUEST' ? '/loans/guest' : '/loans'

  return `${path}?loanId=${encodeURIComponent(line.loanId)}`
}

export function activityLine(line: ProfileActivity, now: Date): ActivityLine {
  if (line.kind === 'COPIES_ADDED') {
    return {
      key: `added:${line.at}`,
      text: `Ви додали ${String(line.count)} ${pluralUk(line.count, ['книжку', 'книжки', 'книжок'])} до бібліотеки`,
      when: shortDate(line.at, now),
      href: '/library',
      icon: 'added',
      tone: 'neutral',
    }
  }

  return {
    key: `${line.loanId}:${line.event}`,
    text: loanText(line),
    when: shortDate(line.at, now),
    href: loanHref(line),
    icon: LOAN_ICON[line.event],
    tone: loanTone(line),
  }
}

// --- Reliability --------------------------------------------------------------

export interface ReliabilityView {
  /** `null` until a loan with a due day has come back: «0 з 0» says nothing. */
  onTime: { text: string; percent: number; ariaLabel: string } | null
  /** `null` until the first return. */
  averageLoan: string | null
  outNow: string
}

/** Under two weeks in days, from then on in weeks: «3 тижні», as the mock-up has it. */
export function loanLengthLabel(days: number): string {
  if (days < 14) return `${String(days)} ${pluralUk(days, ['день', 'дні', 'днів'])}`

  const weeks = Math.round(days / 7)

  return `${String(weeks)} ${pluralUk(weeks, ['тиждень', 'тижні', 'тижнів'])}`
}

export function reliabilityView(reliability: ProfileSummary['reliability']): ReliabilityView {
  const { returnedOnTime, returnedWithDue, averageLoanDays, outNow } = reliability

  return {
    onTime:
      returnedWithDue === 0
        ? null
        : {
            text: `${String(returnedOnTime)} з ${String(returnedWithDue)}`,
            percent: Math.round((returnedOnTime / returnedWithDue) * 100),
            ariaLabel: `${String(returnedOnTime)} з ${String(returnedWithDue)} позик повернуто вчасно`,
          },
    averageLoan: averageLoanDays === null ? null : loanLengthLabel(averageLoanDays),
    outNow: `${String(outNow)} ${pluralUk(outNow, ['книжка', 'книжки', 'книжок'])}`,
  }
}

// --- The whole summary --------------------------------------------------------

export interface ProfileStat {
  key: keyof ProfileSummary['stats']
  value: string
  label: string
}

export interface ProfileFriend {
  key: string
  user: PublicUser
  href: string
}

export interface ProfileSummaryReady {
  stats: ProfileStat[]
  books: { cards: ProfileBookCard[]; total: number }
  activity: ActivityLine[]
  reliability: ReliabilityView
  friends: { items: ProfileFriend[]; total: number }
}

export type ProfileSummaryView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | ({ kind: 'ready' } & ProfileSummaryReady)

export interface ProfileSummaryViewInput {
  data: ProfileSummary | undefined
  error: unknown
  isError: boolean
  /** A read is under way — a manual retry after an error, say. */
  isFetching: boolean
}

const LOAD_FAILED = 'Не вдалося завантажити зведення профілю.'

function statsOf({ copies, friends, lentLoans, wishlist }: ProfileSummary['stats']): ProfileStat[] {
  return [
    {
      key: 'copies',
      value: String(copies),
      label: pluralUk(copies, [
        'книжка в бібліотеці',
        'книжки в бібліотеці',
        'книжок у бібліотеці',
      ]),
    },
    {
      key: 'friends',
      value: String(friends),
      label: pluralUk(friends, ['друг', 'друзі', 'друзів']),
    },
    {
      key: 'lentLoans',
      value: String(lentLoans),
      label: pluralUk(lentLoans, ['позика друзям', 'позики друзям', 'позик друзям']),
    },
    { key: 'wishlist', value: String(wishlist), label: 'у вішлисті' },
  ]
}

function bookCards(books: ProfileSummary['books']['items'], now: Date): ProfileBookCard[] {
  return books.map((book) => {
    const authors = book.authors.map((author) => author.name).join(', ')
    const place = placeLabel(book.place, now)

    return {
      key: book.copyId,
      bookId: book.work.id,
      title: book.work.title,
      authors,
      coverUrl: book.edition.coverUrl,
      href: `/library/${encodeURIComponent(book.copyId)}`,
      place,
      ariaLabel:
        [book.work.title, authors].filter((part) => part !== '').join(', ') + `. ${place.text}`,
    }
  })
}

/**
 * As BS-137's feed: an error is shown once the read has settled — during a retry the sections say
 * they are loading again — and a failed refresh hides what it had, so old numbers are never passed
 * off as current ones.
 */
export function toProfileSummaryView(
  { data, error, isError, isFetching }: ProfileSummaryViewInput,
  now: Date,
): ProfileSummaryView {
  if (isError && !isFetching) {
    return { kind: 'error', message: `${LOAD_FAILED} ${describeError(error)}`.trim() }
  }
  if (data === undefined || isError) return { kind: 'loading' }

  return {
    kind: 'ready',
    stats: statsOf(data.stats),
    books: { cards: bookCards(data.books.items, now), total: data.books.total },
    activity: data.activity.map((line) => activityLine(line, now)),
    reliability: reliabilityView(data.reliability),
    friends: {
      items: data.friends.items.map((user) => ({ key: user.id, user, href: personHref(user) })),
      total: data.friends.total,
    },
  }
}
