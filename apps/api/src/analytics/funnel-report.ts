import { PRODUCT_EVENT_PROPERTIES_SCHEMA, type ProductEventType } from './product-event.types'

const DAY_MS = 24 * 60 * 60 * 1000

export const EMPTY_ANALYTICS_MESSAGES = [
  'Analytics coverage: no product events recorded yet.',
  'The funnel report cannot be calculated.',
] as const

export interface FunnelReportQuery {
  fromDay: string
  toDay: string
  from: Date
  toExclusive: Date
  windowDays: number
}

export interface FunnelSignup {
  subjectUserId: string | null
  occurredAt: Date
}

export interface FunnelEvent {
  type: ProductEventType
  subjectUserId: string | null
  occurredAt: Date
}

export interface FunnelCrossCheck {
  eventOnly: number
  domainOnly: number
}

type BookAddedMethod = ReturnType<
  (typeof PRODUCT_EVENT_PROPERTIES_SCHEMA)['BOOK_ADDED']['parse']
>['method']

/**
 * 8h-3: розподіл `BOOK_ADDED` за способом додавання, за той самий період
 * `[from, toExclusive)`, що й наявний cross-check.
 *
 * `invalidProperties` — не помилка звіту, а окрема категорія: `properties` —
 * нетипізований JSON, тож рядок, записаний майбутньою (чи зламаною) версією,
 * має бути порахований, а не втрачений і не здатний повалити звіт. Лічильник
 * навмисно не несе жодної інформації про сам рядок: ні `dedupeKey`, ні сирих
 * `properties` (§7 — нічого приватного в output).
 */
export interface BookAddedMethodBreakdown extends Record<BookAddedMethod, number> {
  invalidProperties: number
}

/**
 * 8h-5: how long it takes to go from signup to the first and the tenth book.
 *
 * Stage 8's DoD (`docs/plan/roadmap-v2.md`) names `time to first book` and
 * `time to first 10 books`. This is an aggregate and nothing but an aggregate:
 * `sampleSize` is how many people in the cohort reached that mark inside their
 * own conversion window, `medianSeconds` the median of their times. No
 * `subjectUserId`, no raw event (§7 of the 8a plan: nothing about an individual
 * reaches the output).
 *
 * `medianSeconds === null` exactly when `sampleSize === 0`: an empty sample has
 * no median, and `0` here would be a lie — it would read as "instantly".
 */
export interface ActivationTimingStat {
  sampleSize: number
  medianSeconds: number | null
}

export interface ActivationTiming {
  firstBook: ActivationTimingStat
  tenthBook: ActivationTimingStat
}

export interface FunnelReportInput extends FunnelReportQuery {
  earliestEventAt: Date | null
  signups: FunnelSignup[]
  events: FunnelEvent[]
  crossCheck: FunnelCrossCheck
  bookAddedByMethod: BookAddedMethodBreakdown
}

export interface FunnelStep {
  position: number
  key: string
  label: string
  count: number
  percentage: number
}

/**
 * Етап 9 (docs/plan/stage-9-network-activation.md, §2): мережеві метрики.
 *
 * Лише агрегати за когортою: жодного запиту, назви чи id книжки. Відсоток —
 * `null`, коли знаменник нульовий: «0%» читалося б як виміряний провал.
 */
export interface NetworkMetrics {
  invites: { sent: number; accepted: number; acceptancePercent: number | null }
  discovery: {
    searchedUsers: number
    foundUsers: number
    searchToFoundPercent: number | null
    foundAnyUsers: number
    foundThenRequestedUsers: number
    foundToRequestPercent: number | null
  }
}

export interface EmptyFunnelReport {
  status: 'empty'
  messages: readonly [string, string]
}

export interface PopulatedFunnelReport {
  status: 'ok'
  cohort: { from: string; to: string; registrations: number; windowDays: number }
  earliestStoredAnalyticsEvent: string
  warnings: string[]
  steps: FunnelStep[]
  network: NetworkMetrics
  temporaryMetrics: {
    successfulReturnedLoansTotal: number
    successfulReturnedLoansPerActiveUser: number | null
    activeUsers: number
  }
  bookAddedByMethod: BookAddedMethodBreakdown
  activationTiming: ActivationTiming
  crossCheck: { bookAdded: FunnelCrossCheck }
}

export type FunnelReport = EmptyFunnelReport | PopulatedFunnelReport

interface IdentifiedSignup extends FunnelSignup {
  subjectUserId: string
}

interface MemberActivity {
  signup: IdentifiedSignup
  events: FunnelEvent[]
}

interface StepDefinition {
  position: number
  key: string
  label: string
  /** Крок зараховується за будь-яким із цих типів (`friend_book_found` має два джерела). */
  types: readonly ProductEventType[]
  minimum: number
}

const STEP_DEFINITIONS: StepDefinition[] = [
  {
    position: 2,
    key: 'book_added_first',
    label: 'book_added (перша)',
    types: ['BOOK_ADDED'],
    minimum: 1,
  },
  {
    position: 3,
    key: 'book_added_tenth',
    label: 'book_added (10-та)',
    types: ['BOOK_ADDED'],
    minimum: 10,
  },
  { position: 4, key: 'invite_sent', label: 'invite_sent', types: ['INVITE_SENT'], minimum: 1 },
  {
    position: 5,
    key: 'invite_accepted',
    label: 'invite_accepted',
    types: ['INVITE_ACCEPTED'],
    minimum: 1,
  },
  {
    position: 6,
    key: 'friend_accepted',
    label: 'friend_accepted',
    types: ['FRIEND_ACCEPTED'],
    minimum: 1,
  },
  {
    position: 7,
    key: 'friend_inventory_became_usable',
    label: 'friend_inventory_became_usable',
    types: ['FRIEND_INVENTORY_USABLE'],
    minimum: 1,
  },
  {
    position: 8,
    key: 'friend_book_found',
    label: 'friend_book_found',
    types: ['FRIEND_BOOK_FOUND', 'WORK_HOLDERS_FOUND'],
    minimum: 1,
  },
  {
    position: 9,
    key: 'loan_requested',
    label: 'loan_requested',
    types: ['LOAN_REQUESTED'],
    minimum: 1,
  },
  {
    position: 10,
    key: 'loan_approved',
    label: 'loan_approved',
    types: ['LOAN_APPROVED'],
    minimum: 1,
  },
  {
    position: 11,
    key: 'loan_handed_over',
    label: 'loan_handed_over',
    types: ['LOAN_HANDED_OVER'],
    minimum: 1,
  },
  {
    position: 12,
    key: 'loan_returned',
    label: 'loan_returned',
    types: ['LOAN_RETURNED'],
    minimum: 1,
  },
  {
    position: 13,
    key: 'loan_requested_second',
    label: 'loan_requested (2-га)',
    types: ['LOAN_REQUESTED'],
    minimum: 2,
  },
]

function isIdentified(signup: FunnelSignup): signup is IdentifiedSignup {
  return signup.subjectUserId !== null
}

function percentage(count: number, registrations: number): number {
  return registrations === 0 ? 0 : Math.round((count / registrations) * 100)
}

function activityFor(input: FunnelReportInput): MemberActivity[] {
  const eventsBySubject = new Map<string, FunnelEvent[]>()

  for (const event of input.events) {
    if (event.subjectUserId === null) continue

    const events = eventsBySubject.get(event.subjectUserId) ?? []
    events.push(event)
    eventsBySubject.set(event.subjectUserId, events)
  }

  const windowMs = input.windowDays * DAY_MS

  return input.signups.filter(isIdentified).map((signup) => ({
    signup,
    events: (eventsBySubject.get(signup.subjectUserId) ?? []).filter((event) => {
      const elapsed = event.occurredAt.getTime() - signup.occurredAt.getTime()

      return elapsed >= 0 && elapsed <= windowMs
    }),
  }))
}

function instrumentedSteps(activity: MemberActivity[], registrations: number): FunnelStep[] {
  return STEP_DEFINITIONS.map((definition) => {
    const count = activity.filter(
      (member) =>
        member.events.filter((event) => definition.types.includes(event.type)).length >=
        definition.minimum,
    ).length

    return {
      position: definition.position,
      key: definition.key,
      label: definition.label,
      count,
      percentage: percentage(count, registrations),
    }
  })
}

function ratioPercent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 100)
}

/** Мережеві агрегати за тією самою когортою й тими самими вікнами, що й кроки воронки. */
function networkMetrics(activity: MemberActivity[]): NetworkMetrics {
  const count = (type: ProductEventType): number =>
    activity.flatMap((member) => member.events).filter((event) => event.type === type).length
  const users = (predicate: (member: MemberActivity) => boolean): number =>
    activity.filter(predicate).length
  const has = (member: MemberActivity, ...types: ProductEventType[]): boolean =>
    member.events.some((event) => types.includes(event.type))

  const sent = count('INVITE_SENT')
  const accepted = count('INVITE_ACCEPTED')
  const searchedUsers = users((member) => has(member, 'DISCOVERY_SEARCHED'))
  const foundUsers = users((member) => has(member, 'FRIEND_BOOK_FOUND'))
  const foundAnyUsers = users((member) => has(member, 'FRIEND_BOOK_FOUND', 'WORK_HOLDERS_FOUND'))
  const foundThenRequestedUsers = users((member) => {
    const foundAt = member.events
      .filter((event) => event.type === 'FRIEND_BOOK_FOUND' || event.type === 'WORK_HOLDERS_FOUND')
      .map((event) => event.occurredAt.getTime())
      .sort((a, b) => a - b)[0]

    if (foundAt === undefined) return false

    return member.events.some(
      (event) => event.type === 'LOAN_REQUESTED' && event.occurredAt.getTime() >= foundAt,
    )
  })

  return {
    invites: { sent, accepted, acceptancePercent: ratioPercent(accepted, sent) },
    discovery: {
      searchedUsers,
      foundUsers,
      searchToFoundPercent: ratioPercent(foundUsers, searchedUsers),
      foundAnyUsers,
      foundThenRequestedUsers,
      foundToRequestPercent: ratioPercent(foundThenRequestedUsers, foundAnyUsers),
    },
  }
}

function reportWarnings(fromDay: string, earliestDay: string): string[] {
  if (fromDay >= earliestDay) return []

  return [
    `WARNING: cohort starts before the earliest stored analytics event (${earliestDay}).`,
    'Funnel counts may be incomplete. No historical backfill was performed.',
    `Use --from ${earliestDay} or later for a fully instrumented cohort.`,
  ]
}

export function compareDedupeKeys(eventKeys: string[], domainKeys: string[]): FunnelCrossCheck {
  const eventSet = new Set(eventKeys)
  const domainSet = new Set(domainKeys)

  return {
    eventOnly: [...eventSet].filter((key) => !domainSet.has(key)).length,
    domainOnly: [...domainSet].filter((key) => !eventSet.has(key)).length,
  }
}

/**
 * 8h-3: єдине місце, де сирі `properties` взагалі читаються. Викликач передає
 * рівно ті рядки `BOOK_ADDED`, які вже прочитані для cross-check, і далі —
 * і в `FunnelReportInput`, і в presenter — їде тільки результат: чотири числа.
 *
 * Валідація — наявна strict-схема `PRODUCT_EVENT_PROPERTIES_SCHEMA.BOOK_ADDED`,
 * тож `null`, масив, рядок, відсутній чи невідомий `method` і зайве поле всі
 * потрапляють в `invalidProperties` однаково: `safeParse` не кидає, і нічого
 * не логується — інакше сирий JSON витік би в логи в обхід §7.
 */
export function summarizeBookAddedMethods(
  properties: readonly unknown[],
): BookAddedMethodBreakdown {
  const breakdown: BookAddedMethodBreakdown = {
    MANUAL: 0,
    BARCODE: 0,
    CSV: 0,
    invalidProperties: 0,
  }

  for (const value of properties) {
    const parsed = PRODUCT_EVENT_PROPERTIES_SCHEMA.BOOK_ADDED.safeParse(value)

    if (parsed.success) breakdown[parsed.data.method] += 1
    else breakdown.invalidProperties += 1
  }

  return breakdown
}

/** The rank of the book whose arrival closes «time to first 10 books». */
const ACTIVATION_BOOK_TARGET = 10

/**
 * One member of the cohort, as activation timing needs them.
 *
 * `bookAddedAt` holds `BOOK_ADDED` moments already restricted to THIS person's
 * own conversion window (`activityFor`): events before the signup and after the
 * window's end never arrive here at all, so this function neither knows nor
 * decides anything about those boundaries. Order is not assumed — see
 * `summarizeActivationTiming`.
 */
export interface ActivationMember {
  signupAt: Date
  bookAddedAt: readonly Date[]
}

/**
 * A median defined the same way for an odd and an even number of values: odd
 * takes the middle element of the sorted array, even the mean of the two middle
 * ones. Computed on whole milliseconds, so the order values arrived in cannot
 * change the result.
 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const half = Math.floor(sorted.length / 2)
  const upper = sorted[half]

  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper

  const lower = sorted[half - 1]

  return lower === undefined ? upper : (lower + upper) / 2
}

function statOf(elapsedMs: readonly number[]): ActivationTimingStat {
  const median = medianOf(elapsedMs)

  return {
    sampleSize: elapsedMs.length,
    // The median is computed in milliseconds and converted to seconds only
    // here: rounding once at the end rather than per value, otherwise an even
    // median would depend on how its two halves happened to round.
    medianSeconds: median === null ? null : Math.round(median / 1000),
  }
}

export function summarizeActivationTiming(members: readonly ActivationMember[]): ActivationTiming {
  const firstBook: number[] = []
  const tenthBook: number[] = []

  for (const member of members) {
    // Sorted here rather than assumed: neither the events query nor
    // `activityFor` imposes an order. «The first book» is the earliest moment,
    // not whichever row PostgreSQL happened to return first.
    const moments = [...member.bookAddedAt].sort((a, b) => a.getTime() - b.getTime())
    const signupMs = member.signupAt.getTime()
    const first = moments[0]
    const tenth = moments[ACTIVATION_BOOK_TARGET - 1]

    if (first !== undefined) firstBook.push(first.getTime() - signupMs)
    if (tenth !== undefined) tenthBook.push(tenth.getTime() - signupMs)
  }

  return { firstBook: statOf(firstBook), tenthBook: statOf(tenthBook) }
}

export function calculateFunnelReport(input: FunnelReportInput): FunnelReport {
  if (input.earliestEventAt === null) {
    return { status: 'empty', messages: EMPTY_ANALYTICS_MESSAGES }
  }

  const registrations = input.signups.length
  const activity = activityFor(input)
  const steps: FunnelStep[] = [
    {
      position: 1,
      key: 'signup',
      label: 'signup',
      count: registrations,
      percentage: registrations === 0 ? 0 : 100,
    },
    ...instrumentedSteps(activity, registrations),
  ]
  const returnedLoans = activity
    .flatMap((member) => member.events)
    .filter((event) => event.type === 'LOAN_RETURNED').length
  const activeUsers = activity.filter((member) => member.events.length > 0).length
  const earliestDay = input.earliestEventAt.toISOString().slice(0, 10)

  return {
    status: 'ok',
    cohort: {
      from: input.fromDay,
      to: input.toDay,
      registrations,
      windowDays: input.windowDays,
    },
    earliestStoredAnalyticsEvent: earliestDay,
    warnings: reportWarnings(input.fromDay, earliestDay),
    steps,
    network: networkMetrics(activity),
    temporaryMetrics: {
      successfulReturnedLoansTotal: returnedLoans,
      successfulReturnedLoansPerActiveUser:
        activeUsers === 0 ? null : Number((returnedLoans / activeUsers).toFixed(2)),
      activeUsers,
    },
    bookAddedByMethod: input.bookAddedByMethod,
    // Computed from the same `activity` the funnel steps are — the same cohort
    // and the same per-member conversion windows. No second read of the table,
    // no new entity, no new event type.
    activationTiming: summarizeActivationTiming(
      activity.map((member) => ({
        signupAt: member.signup.occurredAt,
        bookAddedAt: member.events
          .filter((event) => event.type === 'BOOK_ADDED')
          .map((event) => event.occurredAt),
      })),
    ),
    crossCheck: { bookAdded: input.crossCheck },
  }
}
