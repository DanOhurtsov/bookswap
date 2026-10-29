import type { Edition, Work } from './catalog'
import {
  profileActivitySchema,
  profileBookPlaceSchema,
  profileSummarySchema,
  type ProfileSummary,
} from './profile-summary'

const edition: Edition = {
  id: 'edition-1',
  workId: 'work-1',
  translationId: null,
  publisher: null,
  year: null,
  isbn13: null,
  pageCount: null,
  coverUrl: null,
  format: 'PAPERBACK',
  textKind: 'ORIGINAL',
  lang: 'uk',
  translator: null,
  revision: 1,
}

const work: Work = {
  id: 'work-1',
  title: 'Тигролови',
  origLang: 'uk',
  firstPubYear: 1944,
  description: null,
  createdAt: '2026-03-01T10:00:00.000Z',
  revision: 1,
}

const serhii = { id: 'user-2', displayName: 'Сергій', handle: 'serhii', avatarUrl: null }

const summary: ProfileSummary = {
  stats: { copies: 12, friends: 3, lentLoans: 7, wishlist: 2 },
  reliability: { returnedOnTime: 4, returnedWithDue: 5, averageLoanDays: 18, outNow: 2 },
  books: {
    items: [
      {
        copyId: 'copy-1',
        edition,
        work,
        authors: [],
        place: {
          kind: 'LENT',
          holder: { kind: 'USER', user: serhii },
          dueAt: '2026-11-02',
          overdue: false,
        },
      },
    ],
    total: 12,
  },
  friends: { items: [serhii], total: 3 },
  activity: [
    {
      kind: 'LOAN',
      event: 'HANDED_OVER',
      at: '2026-10-20T09:00:00.000Z',
      loanId: 'loan-1',
      role: 'OWNER',
      counterpart: { kind: 'USER', user: serhii },
      work: { id: work.id, title: work.title },
    },
    { kind: 'COPIES_ADDED', at: '2026-10-19T18:00:00.000Z', count: 3 },
  ],
}

describe('profileSummarySchema', () => {
  it('приймає повне зведення', () => {
    expect(profileSummarySchema.parse(summary)).toEqual(summary)
  })

  it('середній термін — ціле число днів або null до першого повернення', () => {
    const withAverage = (averageLoanDays: number | null) =>
      profileSummarySchema.safeParse({
        ...summary,
        reliability: { ...summary.reliability, averageLoanDays },
      }).success

    expect(withAverage(null)).toBe(true)
    expect(withAverage(0)).toBe(true)
    expect(withAverage(1.5)).toBe(false)
    expect(withAverage(-1)).toBe(false)
  })
})

describe('profileBookPlaceSchema', () => {
  it('гість-тримач — за аліасом власника, або без імені після стирання контакту', () => {
    for (const alias of ['Сусідка Оля', null]) {
      expect(
        profileBookPlaceSchema.safeParse({
          kind: 'LENT',
          holder: { kind: 'GUEST', alias },
          dueAt: null,
          overdue: false,
        }).success,
      ).toBe(true)
    }
  })

  it('термін — календарний день, а не мить', () => {
    expect(
      profileBookPlaceSchema.safeParse({
        kind: 'LENT',
        holder: { kind: 'USER', user: serhii },
        dueAt: '2026-11-02T23:59:59.999Z',
        overdue: false,
      }).success,
    ).toBe(false)
  })

  it('«є запит» без жодного запиту — не стан', () => {
    expect(
      profileBookPlaceSchema.safeParse({ kind: 'HOME_REQUESTED', pendingRequestCount: 0 }).success,
    ).toBe(false)
  })
})

describe('profileActivitySchema', () => {
  it('відхиляє подію позики, якої немає в переліку', () => {
    expect(profileActivitySchema.safeParse({ ...summary.activity[0], event: 'LOST' }).success).toBe(
      false,
    )
  })

  it('додані примірники — щонайменше один', () => {
    expect(
      profileActivitySchema.safeParse({
        kind: 'COPIES_ADDED',
        at: summary.activity[1]?.at,
        count: 0,
      }).success,
    ).toBe(false)
  })
})
