import type { ProductEventType } from './product-event.types'
import {
  EMPTY_ANALYTICS_MESSAGES,
  NOT_INSTRUMENTED_NOTE,
  calculateFunnelReport,
  compareDedupeKeys,
  summarizeActivationTiming,
  summarizeBookAddedMethods,
  type ActivationMember,
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

/** 8h-5: time to first book / time to first 10 books (Stage 8 DoD). */
describe('activation timing', () => {
  const SIGNUP = new Date('2026-01-02T00:00:00.000Z')

  /** `n` BOOK_ADDED events for one person, offset from their signup in seconds. */
  function books(userId: string, signup: Date, offsetsSeconds: number[]): FunnelEvent[] {
    return offsetsSeconds.map((seconds) =>
      event('BOOK_ADDED', userId, new Date(signup.getTime() + seconds * 1000)),
    )
  }

  function member(signupAt: Date, offsetsSeconds: number[]): ActivationMember {
    return {
      signupAt,
      bookAddedAt: offsetsSeconds.map((seconds) => new Date(signupAt.getTime() + seconds * 1000)),
    }
  }

  describe('summarizeActivationTiming', () => {
    it('measures the first and the tenth book from the signup', () => {
      // 10 books: the first after 60 s, the tenth after 3600 s.
      expect(
        summarizeActivationTiming([
          member(SIGNUP, [60, 120, 180, 240, 300, 360, 420, 480, 540, 3600]),
        ]),
      ).toEqual({
        firstBook: { sampleSize: 1, medianSeconds: 60 },
        tenthBook: { sampleSize: 1, medianSeconds: 3600 },
      })
    })

    it('assumes no input order — «first» is the earliest, not the first in the array', () => {
      const shuffled = summarizeActivationTiming([
        member(SIGNUP, [3600, 540, 60, 480, 120, 420, 180, 360, 240, 300]),
      ])

      expect(shuffled).toEqual({
        firstBook: { sampleSize: 1, medianSeconds: 60 },
        tenthBook: { sampleSize: 1, medianSeconds: 3600 },
      })
    })

    it('a person short of ten books contributes to firstBook only', () => {
      expect(summarizeActivationTiming([member(SIGNUP, [30, 60, 90])])).toEqual({
        firstBook: { sampleSize: 1, medianSeconds: 30 },
        tenthBook: { sampleSize: 0, medianSeconds: null },
      })
    })

    it('no converters at all — sampleSize 0 and medianSeconds null, not zero seconds', () => {
      expect(summarizeActivationTiming([member(SIGNUP, []), member(SIGNUP, [])])).toEqual({
        firstBook: { sampleSize: 0, medianSeconds: null },
        tenthBook: { sampleSize: 0, medianSeconds: null },
      })
      expect(summarizeActivationTiming([])).toEqual({
        firstBook: { sampleSize: 0, medianSeconds: null },
        tenthBook: { sampleSize: 0, medianSeconds: null },
      })
    })

    it('an odd sample takes the middle element', () => {
      expect(
        summarizeActivationTiming([
          member(SIGNUP, [10]),
          member(SIGNUP, [70]),
          member(SIGNUP, [30]),
        ]).firstBook,
      ).toEqual({ sampleSize: 3, medianSeconds: 30 })
    })

    it('an even sample takes the mean of the two middle elements', () => {
      expect(
        summarizeActivationTiming([
          member(SIGNUP, [10]),
          member(SIGNUP, [40]),
          member(SIGNUP, [20]),
          member(SIGNUP, [100]),
        ]).firstBook,
      ).toEqual({ sampleSize: 4, medianSeconds: 30 })
    })

    it('the median does not depend on the order people appear in', () => {
      const ascending = summarizeActivationTiming([
        member(SIGNUP, [10]),
        member(SIGNUP, [20]),
        member(SIGNUP, [40]),
        member(SIGNUP, [100]),
      ]).firstBook
      const descending = summarizeActivationTiming([
        member(SIGNUP, [100]),
        member(SIGNUP, [40]),
        member(SIGNUP, [20]),
        member(SIGNUP, [10]),
      ]).firstBook

      expect(ascending).toEqual(descending)
      expect(ascending).toEqual({ sampleSize: 4, medianSeconds: 30 })
    })

    it('a zero elapse is 0 seconds, not «no value»', () => {
      expect(summarizeActivationTiming([member(SIGNUP, [0])]).firstBook).toEqual({
        sampleSize: 1,
        medianSeconds: 0,
      })
    })
  })

  describe('inside the report', () => {
    it('counts an event exactly at the signup and exactly at the window edge', () => {
      const windowEnd = 10 * DAY_MS
      const report = calculateFunnelReport(
        input({
          windowDays: 10,
          signups: [{ subjectUserId: 'user-1', occurredAt: SIGNUP }],
          events: [
            event('BOOK_ADDED', 'user-1', SIGNUP),
            event('BOOK_ADDED', 'user-1', new Date(SIGNUP.getTime() + windowEnd)),
          ],
        }),
      )

      expect(report.status).toBe('ok')
      if (report.status === 'empty') return

      // Both events fall inside the window: the first at 0 s, and there is no tenth.
      expect(report.activationTiming.firstBook).toEqual({ sampleSize: 1, medianSeconds: 0 })
      expect(report.activationTiming.tenthBook).toEqual({ sampleSize: 0, medianSeconds: null })
    })

    it('ignores events before the signup and after the window ends', () => {
      const windowEnd = 10 * DAY_MS
      const report = calculateFunnelReport(
        input({
          windowDays: 10,
          signups: [{ subjectUserId: 'user-1', occurredAt: SIGNUP }],
          events: [
            // One second BEFORE the signup — not counted at all.
            event('BOOK_ADDED', 'user-1', new Date(SIGNUP.getTime() - 1000)),
            // One millisecond AFTER the window ends — likewise not.
            event('BOOK_ADDED', 'user-1', new Date(SIGNUP.getTime() + windowEnd + 1)),
            // The only event inside the window.
            event('BOOK_ADDED', 'user-1', new Date(SIGNUP.getTime() + 300_000)),
          ],
        }),
      )

      expect(report.status).toBe('ok')
      if (report.status === 'empty') return

      expect(report.activationTiming.firstBook).toEqual({ sampleSize: 1, medianSeconds: 300 })
    })

    it('a cohort with ten books for one person and three for another', () => {
      const secondSignup = new Date('2026-01-04T00:00:00.000Z')
      const report = calculateFunnelReport(
        input({
          windowDays: 10,
          signups: [
            { subjectUserId: 'user-1', occurredAt: SIGNUP },
            { subjectUserId: 'user-2', occurredAt: secondSignup },
            // An unidentified signup takes no part in the calculation.
            { subjectUserId: null, occurredAt: SIGNUP },
          ],
          events: [
            ...books('user-1', SIGNUP, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]),
            ...books('user-2', secondSignup, [200, 400, 600]),
          ],
        }),
      )

      expect(report.status).toBe('ok')
      if (report.status === 'empty') return

      // firstBook: 100 and 200 → even median 150. tenthBook: user-1 only.
      expect(report.activationTiming).toEqual({
        firstBook: { sampleSize: 2, medianSeconds: 150 },
        tenthBook: { sampleSize: 1, medianSeconds: 1000 },
      })
    })

    it('text and JSON show the same model, with no user id and no raw events', () => {
      const report = calculateFunnelReport(
        input({
          windowDays: 10,
          signups: [{ subjectUserId: 'secret-user-8h5', occurredAt: SIGNUP }],
          events: books(
            'secret-user-8h5',
            SIGNUP,
            [3600, 7200, 10_800, 14_400, 18_000, 21_600, 25_200, 28_800, 32_400, 90_000],
          ),
        }),
      )

      expect(report.status).toBe('ok')
      if (report.status === 'empty') return

      const text = formatFunnelReportText(report)
      const rendered = formatFunnelReportJson(report)
      const json: unknown = JSON.parse(rendered)

      expect(json).toMatchObject({
        activationTiming: {
          firstBook: { sampleSize: 1, medianSeconds: 3600 },
          tenthBook: { sampleSize: 1, medianSeconds: 90_000 },
        },
      })

      expect(text).toContain('Activation timing (від signup, те саме вікно конверсії):')
      // The same number as in the JSON, plus its human reading.
      expect(text).toContain('3600 с  (1 год 0 хв)')
      expect(text).toContain('90000 с  (1 дн 1 год)')
      expect(text).toContain('вибірка: 1')

      expect(text).not.toContain('secret-user-8h5')
      expect(rendered).not.toContain('secret-user-8h5')
    })

    it('an empty sample prints as «—» rather than as zero seconds', () => {
      const text = formatFunnelReportText(calculateFunnelReport(input()))

      expect(text).toContain('до 1-ї книги')
      expect(text).toContain('median: —   вибірка: 0')
    })

    it('an empty report gets no activation timing section', () => {
      const report = calculateFunnelReport(input({ earliestEventAt: null }))

      expect(formatFunnelReportText(report)).not.toContain('Activation timing')
    })
  })
})
