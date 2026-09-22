import { PRODUCT_EVENT_PROPERTIES_SCHEMA, type ProductEventType } from './product-event.types'

const DAY_MS = 24 * 60 * 60 * 1000

export const EMPTY_ANALYTICS_MESSAGES = [
  'Analytics coverage: no product events recorded yet.',
  'The funnel report cannot be calculated.',
] as const

export const NOT_INSTRUMENTED_NOTE = 'not instrumented — Stage 9'

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

interface InstrumentedStep {
  position: number
  key: string
  label: string
  count: number
  percentage: number
  note: null
}

interface UninstrumentedStep {
  position: number
  key: string
  label: string
  count: null
  percentage: null
  note: typeof NOT_INSTRUMENTED_NOTE
}

export type FunnelStep = InstrumentedStep | UninstrumentedStep

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
  type: ProductEventType
  minimum: number
}

const STEP_DEFINITIONS: StepDefinition[] = [
  {
    position: 2,
    key: 'book_added_first',
    label: 'book_added (перша)',
    type: 'BOOK_ADDED',
    minimum: 1,
  },
  {
    position: 3,
    key: 'book_added_tenth',
    label: 'book_added (10-та)',
    type: 'BOOK_ADDED',
    minimum: 10,
  },
  {
    position: 4,
    key: 'friend_accepted',
    label: 'friend_accepted',
    type: 'FRIEND_ACCEPTED',
    minimum: 1,
  },
  {
    position: 7,
    key: 'loan_requested',
    label: 'loan_requested',
    type: 'LOAN_REQUESTED',
    minimum: 1,
  },
  { position: 8, key: 'loan_approved', label: 'loan_approved', type: 'LOAN_APPROVED', minimum: 1 },
  {
    position: 9,
    key: 'loan_handed_over',
    label: 'loan_handed_over',
    type: 'LOAN_HANDED_OVER',
    minimum: 1,
  },
  { position: 10, key: 'loan_returned', label: 'loan_returned', type: 'LOAN_RETURNED', minimum: 1 },
  {
    position: 11,
    key: 'loan_requested_second',
    label: 'loan_requested (2-га)',
    type: 'LOAN_REQUESTED',
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

function instrumentedSteps(activity: MemberActivity[], registrations: number): InstrumentedStep[] {
  return STEP_DEFINITIONS.map((definition) => {
    const count = activity.filter(
      (member) =>
        member.events.filter((event) => event.type === definition.type).length >=
        definition.minimum,
    ).length

    return {
      position: definition.position,
      key: definition.key,
      label: definition.label,
      count,
      percentage: percentage(count, registrations),
      note: null,
    }
  })
}

function uninstrumentedStep(position: number, key: string, label: string): UninstrumentedStep {
  return { position, key, label, count: null, percentage: null, note: NOT_INSTRUMENTED_NOTE }
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
  const trackedSteps = instrumentedSteps(activity, registrations)
  const steps: FunnelStep[] = [
    {
      position: 1,
      key: 'signup',
      label: 'signup',
      count: registrations,
      percentage: registrations === 0 ? 0 : 100,
      note: null,
    },
    ...trackedSteps.filter((step) => step.position < 5),
    uninstrumentedStep(5, 'friend_inventory_became_usable', 'friend_inventory_became_usable'),
    uninstrumentedStep(6, 'friend_book_found', 'friend_book_found'),
    ...trackedSteps.filter((step) => step.position > 6),
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
