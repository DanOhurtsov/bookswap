import type { ProductEventType } from './product-event.types'
import {
  EMPTY_ANALYTICS_MESSAGES,
  NOT_INSTRUMENTED_NOTE,
  calculateFunnelReport,
  compareDedupeKeys,
  summarizeBookAddedMethods,
  type FunnelEvent,
  type FunnelReportInput,
} from './funnel-report'
import { formatFunnelReportJson, formatFunnelReportText } from './funnel-report.presenter'

const DAY_MS = 24 * 60 * 60 * 1000

function event(type: ProductEventType, subjectUserId: string, occurredAt: Date): FunnelEvent {
  return { type, subjectUserId, occurredAt }
}

function input(overrides: Partial<FunnelReportInput> = {}): FunnelReportInput {
  return {
    fromDay: '2026-01-01',
    toDay: '2026-01-31',
    from: new Date('2026-01-01T00:00:00.000Z'),
    toExclusive: new Date('2026-02-01T00:00:00.000Z'),
    windowDays: 10,
    earliestEventAt: new Date('2026-01-01T00:00:00.000Z'),
    signups: [],
    events: [],
    crossCheck: { eventOnly: 0, domainOnly: 0 },
    bookAddedByMethod: { MANUAL: 0, BARCODE: 0, CSV: 0, invalidProperties: 0 },
    ...overrides,
  }
}

describe('funnel report calculation', () => {
  it('counts per-user conversion windows, Nth events, active users, and returned loans', () => {
    const firstSignup = new Date('2026-01-02T12:00:00.000Z')
    const secondSignup = new Date('2026-01-05T00:00:00.000Z')
    const firstBooks = Array.from({ length: 10 }, (_, index) =>
      event('BOOK_ADDED', 'user-1', new Date(firstSignup.getTime() + index)),
    )
    const report = calculateFunnelReport(
      input({
        signups: [
          { subjectUserId: 'user-1', occurredAt: firstSignup },
          { subjectUserId: null, occurredAt: new Date('2026-01-03T00:00:00.000Z') },
          { subjectUserId: 'user-2', occurredAt: secondSignup },
        ],
        events: [
          ...firstBooks,
          event('FRIEND_ACCEPTED', 'user-1', firstSignup),
          event('LOAN_REQUESTED', 'user-1', firstSignup),
          event('LOAN_REQUESTED', 'user-1', new Date(firstSignup.getTime() + DAY_MS)),
          event('LOAN_APPROVED', 'user-1', new Date(firstSignup.getTime() + DAY_MS)),
          event('LOAN_HANDED_OVER', 'user-1', new Date(firstSignup.getTime() + DAY_MS)),
          event('LOAN_RETURNED', 'user-1', new Date(firstSignup.getTime() + DAY_MS)),
          event('BOOK_ADDED', 'user-2', new Date(secondSignup.getTime() + 10 * DAY_MS)),
          event('LOAN_RETURNED', 'user-2', new Date(secondSignup.getTime() + 10 * DAY_MS)),
          event('LOAN_RETURNED', 'user-2', new Date(secondSignup.getTime() - 1)),
          event('LOAN_RETURNED', 'user-1', new Date(firstSignup.getTime() + 10 * DAY_MS + 1)),
        ],
        crossCheck: { eventOnly: 2, domainOnly: 3 },
      }),
    )

    expect(report.status).toBe('ok')
    if (report.status === 'empty') return

    expect(report.steps.map(({ key, count, percentage }) => ({ key, count, percentage }))).toEqual([
      { key: 'signup', count: 3, percentage: 100 },
      { key: 'book_added_first', count: 2, percentage: 67 },
      { key: 'book_added_tenth', count: 1, percentage: 33 },
      { key: 'friend_accepted', count: 1, percentage: 33 },
      { key: 'friend_inventory_became_usable', count: null, percentage: null },
      { key: 'friend_book_found', count: null, percentage: null },
      { key: 'loan_requested', count: 1, percentage: 33 },
      { key: 'loan_approved', count: 1, percentage: 33 },
      { key: 'loan_handed_over', count: 1, percentage: 33 },
      { key: 'loan_returned', count: 2, percentage: 67 },
      { key: 'loan_requested_second', count: 1, percentage: 33 },
    ])
    expect(report.temporaryMetrics).toEqual({
      successfulReturnedLoansTotal: 2,
      successfulReturnedLoansPerActiveUser: 1,
      activeUsers: 2,
    })
    expect(report.crossCheck.bookAdded).toEqual({ eventOnly: 2, domainOnly: 3 })
  })

  it('prints the exact empty-table message', () => {
    const report = calculateFunnelReport(input({ earliestEventAt: null }))

    expect(formatFunnelReportText(report)).toBe(EMPTY_ANALYTICS_MESSAGES.join('\n'))
  })

  it('prints the coverage warning and explicit Stage 9 gaps', () => {
    const report = calculateFunnelReport(
      input({ earliestEventAt: new Date('2026-01-05T00:00:00.000Z') }),
    )
    const text = formatFunnelReportText(report)

    expect(text).toContain(
      'WARNING: cohort starts before the earliest stored analytics event (2026-01-05).\n' +
        'Funnel counts may be incomplete. No historical backfill was performed.\n' +
        'Use --from 2026-01-05 or later for a fully instrumented cohort.',
    )
    expect(text.match(new RegExp(NOT_INSTRUMENTED_NOTE, 'g'))).toHaveLength(2)
    expect(text).toContain('event-only: 0   domain-only: 0')
  })

  it('serializes the same report model in JSON mode', () => {
    const report = calculateFunnelReport(input())

    expect(formatFunnelReportJson(report)).toBe(JSON.stringify(report, null, 2))
  })
})

/** 8h-3: розподіл BOOK_ADDED за MANUAL / BARCODE / CSV. */
describe('BOOK_ADDED method breakdown', () => {
  /** Приватні значення, яких не має бути ні в text-, ні в JSON-виводі (§7). */
  const SECRET_TITLE = 'PRIVATE-TITLE-8h3-4f2a'
  const SECRET_EMAIL = 'private-8h3@example.com'

  it('counts each method separately', () => {
    expect(
      summarizeBookAddedMethods([
        { method: 'MANUAL' },
        { method: 'BARCODE' },
        { method: 'BARCODE' },
        { method: 'CSV' },
        { method: 'CSV' },
        { method: 'CSV' },
      ]),
    ).toEqual({ MANUAL: 1, BARCODE: 2, CSV: 3, invalidProperties: 0 })
  })

  it('keeps all four fields present at zero when there is nothing to count', () => {
    expect(summarizeBookAddedMethods([])).toEqual({
      MANUAL: 0,
      BARCODE: 0,
      CSV: 0,
      invalidProperties: 0,
    })
  })

  it('counts malformed, unknown and extra-field properties as invalid without throwing', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      'MANUAL',
      42,
      {},
      { method: null },
      { method: 'SCANNER' },
      { method: 'manual' },
      { method: 'MANUAL', title: SECRET_TITLE },
      { method: 'CSV', email: SECRET_EMAIL },
    ]

    expect(() => summarizeBookAddedMethods(malformed)).not.toThrow()
    expect(summarizeBookAddedMethods(malformed)).toEqual({
      MANUAL: 0,
      BARCODE: 0,
      CSV: 0,
      invalidProperties: malformed.length,
    })
  })

  it('splits every row into exactly one bucket, so the four counts sum to the row count', () => {
    const rows: unknown[] = [
      { method: 'MANUAL' },
      { method: 'MANUAL' },
      { method: 'BARCODE' },
      { method: 'CSV' },
      { method: 'UNKNOWN' },
      null,
    ]
    const breakdown = summarizeBookAddedMethods(rows)

    expect(breakdown.MANUAL + breakdown.BARCODE + breakdown.CSV + breakdown.invalidProperties).toBe(
      rows.length,
    )
  })

  it('carries the breakdown into the populated report, presenting it in text and JSON', () => {
    const report = calculateFunnelReport(
      input({
        bookAddedByMethod: summarizeBookAddedMethods([
          { method: 'MANUAL' },
          { method: 'MANUAL' },
          { method: 'BARCODE' },
          { method: 'CSV' },
          { method: 'CSV' },
          { method: 'CSV' },
          { method: 'MANUAL', title: SECRET_TITLE },
          { isbn13: '9786177535019', email: SECRET_EMAIL },
        ]),
      }),
    )

    expect(report.status).toBe('ok')
    if (report.status === 'empty') return

    expect(report.bookAddedByMethod).toEqual({
      MANUAL: 2,
      BARCODE: 1,
      CSV: 3,
      invalidProperties: 2,
    })

    const text = formatFunnelReportText(report)
    expect(text).toContain('  MANUAL: 2')
    expect(text).toContain('  BARCODE: 1')
    expect(text).toContain('  CSV: 3')
    expect(text).toContain('  invalidProperties: 2')

    const json: unknown = JSON.parse(formatFunnelReportJson(report))
    expect(json).toMatchObject({
      bookAddedByMethod: { MANUAL: 2, BARCODE: 1, CSV: 3, invalidProperties: 2 },
    })

    for (const secret of [SECRET_TITLE, SECRET_EMAIL, '9786177535019']) {
      expect(text).not.toContain(secret)
      expect(formatFunnelReportJson(report)).not.toContain(secret)
    }
  })

  it('shows all four zeros rather than omitting the section', () => {
    const text = formatFunnelReportText(calculateFunnelReport(input()))

    expect(text).toContain(
      ['  MANUAL: 0', '  BARCODE: 0', '  CSV: 0', '  invalidProperties: 0'].join('\n'),
    )
  })

  it('leaves the empty report untouched', () => {
    const report = calculateFunnelReport(
      input({
        earliestEventAt: null,
        bookAddedByMethod: summarizeBookAddedMethods([{ method: 'MANUAL' }]),
      }),
    )

    expect(report).toEqual({ status: 'empty', messages: EMPTY_ANALYTICS_MESSAGES })
    expect(formatFunnelReportText(report)).toBe(EMPTY_ANALYTICS_MESSAGES.join('\n'))
    expect(formatFunnelReportText(report)).not.toContain('MANUAL')
  })
})

describe('BOOK_ADDED cross-check', () => {
  it('reports event-only and domain-only keys separately and ignores duplicates', () => {
    expect(compareDedupeKeys(['shared', 'event', 'event'], ['shared', 'domain'])).toEqual({
      eventOnly: 1,
      domainOnly: 1,
    })
  })
})
