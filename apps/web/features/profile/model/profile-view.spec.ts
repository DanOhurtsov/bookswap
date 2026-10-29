import type { ProfileActivity, ProfileSummary, PublicUser } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import {
  activityLine,
  counterpartName,
  loanLengthLabel,
  placeLabel,
  pluralUk,
  profileMetaLine,
  reliabilityView,
  shortDate,
  toProfileSummaryView,
} from './profile-view'

const NOW = new Date('2026-10-27T12:00:00.000Z')
const ANDRII: PublicUser = {
  id: 'user-2',
  displayName: 'Андрій',
  handle: 'andrii',
  avatarUrl: null,
}
const andrii = { kind: 'USER', user: ANDRII } as const

describe('pluralUk', () => {
  const forms = ['книжка', 'книжки', 'книжок'] as const

  it.each([
    [0, 'книжок'],
    [1, 'книжка'],
    [2, 'книжки'],
    [4, 'книжки'],
    [5, 'книжок'],
    [11, 'книжок'],
    [14, 'книжок'],
    [21, 'книжка'],
    [22, 'книжки'],
    [111, 'книжок'],
  ])('%i → %s', (count, expected) => {
    expect(pluralUk(count, forms)).toBe(expected)
  })
})

describe('profileMetaLine', () => {
  it('нік і місто', () => {
    expect(profileMetaLine({ handle: 'marta', city: 'Вроцлав' })).toBe('@marta · Вроцлав')
  })

  it('без міста — лише нік, без зайвої крапки', () => {
    expect(profileMetaLine({ handle: 'marta', city: null })).toBe('@marta')
  })
})

describe('shortDate', () => {
  it('цього року — без року; іншого — з роком', () => {
    expect(shortDate('2026-10-22T10:00:00.000Z', NOW)).toBe('22 жовт.')
    expect(shortDate('2025-10-22T10:00:00.000Z', NOW)).toMatch(/^22 жовт\. 2025/)
  })

  it('календарний день не зсувається часовим поясом', () => {
    expect(shortDate('2026-11-02', NOW)).toBe('2 лист.')
  })
})

describe('counterpartName', () => {
  it('людина — за іменем, гість — за аліасом власника, стертий гість — «гість»', () => {
    expect(counterpartName(andrii)).toBe('Андрій')
    expect(counterpartName({ kind: 'GUEST', alias: 'Сусідка Оля' })).toBe('Сусідка Оля')
    expect(counterpartName({ kind: 'GUEST', alias: null })).toBe('гість')
  })
})

describe('placeLabel', () => {
  it.each([
    [{ kind: 'HOME' }, 'Вдома', 'home'],
    [{ kind: 'HOME_REQUESTED', pendingRequestCount: 1 }, 'Вдома · є запит', 'requested'],
    [{ kind: 'HOME_REQUESTED', pendingRequestCount: 3 }, 'Вдома · 3 запити', 'requested'],
    [{ kind: 'RESERVED', borrower: andrii }, 'Чекає передачі · Андрій', 'requested'],
    [{ kind: 'UNAVAILABLE' }, 'Не позичається', 'muted'],
    [
      { kind: 'LENT', holder: andrii, dueAt: '2026-11-02', overdue: false },
      'У Андрій до 2 лист.',
      'out',
    ],
    [{ kind: 'LENT', holder: andrii, dueAt: null, overdue: false }, 'У Андрій', 'out'],
    [
      { kind: 'LENT', holder: andrii, dueAt: '2026-10-20', overdue: true },
      'У Андрій · прострочено',
      'overdue',
    ],
    [{ kind: 'LOST', holder: { kind: 'GUEST', alias: null } }, 'Втрачено · гість', 'overdue'],
  ] as const)('%o → %s', (place, text, tone) => {
    expect(placeLabel(place, NOW)).toEqual({ text, tone })
  })
})

describe('activityLine', () => {
  function loan(
    overrides: Partial<Extract<ProfileActivity, { kind: 'LOAN' }>>,
  ): Extract<ProfileActivity, { kind: 'LOAN' }> {
    return {
      kind: 'LOAN',
      event: 'REQUESTED',
      at: '2026-10-22T10:00:00.000Z',
      loanId: 'loan-1',
      role: 'OWNER',
      counterpart: andrii,
      work: { id: 'work-1', title: 'Дюна' },
      ...overrides,
    }
  }

  it.each([
    ['OWNER', 'REQUESTED', 'Андрій просить книжку «Дюна»', 'action'],
    ['OWNER', 'APPROVED', 'Ви погодили запит на книжку «Дюна» від Андрій', 'positive'],
    ['OWNER', 'REJECTED', 'Ви відхилили запит на книжку «Дюна» від Андрій', 'neutral'],
    ['OWNER', 'HANDED_OVER', 'Книжка «Дюна» тепер у Андрій', 'out'],
    ['OWNER', 'RETURNED', 'Книжка «Дюна» повернулася від Андрій', 'positive'],
    ['BORROWER', 'REQUESTED', 'Ви попросили книжку «Дюна» у Андрій', 'neutral'],
    ['BORROWER', 'APPROVED', 'Андрій погоджує ваш запит на книжку «Дюна»', 'positive'],
    ['BORROWER', 'REJECTED', 'Андрій відхиляє ваш запит на книжку «Дюна»', 'neutral'],
    ['BORROWER', 'HANDED_OVER', 'Книжка «Дюна» тепер у вас', 'out'],
    ['BORROWER', 'RETURNED', 'Ви повернули книжку «Дюна»', 'positive'],
  ] as const)('%s · %s → %s', (role, event, text, tone) => {
    expect(activityLine(loan({ role, event }), NOW)).toMatchObject({
      text,
      tone,
      when: '22 жовт.',
      href: '/loans?loanId=loan-1',
    })
  })

  it('гостьова позика веде на сторінку гостьових позик і називає гостя аліасом', () => {
    expect(
      activityLine(
        loan({ event: 'HANDED_OVER', counterpart: { kind: 'GUEST', alias: 'Сусідка Оля' } }),
        NOW,
      ),
    ).toMatchObject({
      text: 'Книжка «Дюна» тепер у Сусідка Оля',
      href: '/loans/guest?loanId=loan-1',
    })
  })

  it('додані книжки — одним рядком із правильною формою, веде в бібліотеку', () => {
    const added = (count: number) =>
      activityLine({ kind: 'COPIES_ADDED', at: '2026-10-15T18:00:00.000Z', count }, NOW)

    expect(added(1)).toMatchObject({
      text: 'Ви додали 1 книжку до бібліотеки',
      when: '15 жовт.',
      href: '/library',
      icon: 'added',
    })
    expect(added(3).text).toBe('Ви додали 3 книжки до бібліотеки')
    expect(added(5).text).toBe('Ви додали 5 книжок до бібліотеки')
  })
})

describe('reliabilityView', () => {
  it('«18 з 19», відсоток для смуги, середній термін і книжки в інших', () => {
    expect(
      reliabilityView({ returnedOnTime: 18, returnedWithDue: 19, averageLoanDays: 20, outNow: 2 }),
    ).toEqual({
      onTime: { text: '18 з 19', percent: 95, ariaLabel: '18 з 19 позик повернуто вчасно' },
      averageLoan: '3 тижні',
      outNow: '2 книжки',
    })
  })

  it('без повернень із терміном і без жодного повернення — нічого не вигадує', () => {
    expect(
      reliabilityView({ returnedOnTime: 0, returnedWithDue: 0, averageLoanDays: null, outNow: 0 }),
    ).toEqual({ onTime: null, averageLoan: null, outNow: '0 книжок' })
  })
})

describe('loanLengthLabel', () => {
  it('до двох тижнів — у днях, далі — у тижнях', () => {
    expect(loanLengthLabel(1)).toBe('1 день')
    expect(loanLengthLabel(3)).toBe('3 дні')
    expect(loanLengthLabel(13)).toBe('13 днів')
    expect(loanLengthLabel(14)).toBe('2 тижні')
    expect(loanLengthLabel(35)).toBe('5 тижнів')
  })
})

describe('toProfileSummaryView', () => {
  const summary: ProfileSummary = {
    stats: { copies: 86, friends: 23, lentLoans: 41, wishlist: 12 },
    reliability: { returnedOnTime: 1, returnedWithDue: 1, averageLoanDays: 10, outNow: 1 },
    books: {
      items: [
        {
          copyId: 'copy-1',
          edition: {
            id: 'edition-1',
            workId: 'work-1',
            translationId: null,
            publisher: null,
            year: null,
            isbn13: null,
            pageCount: null,
            coverUrl: 'https://img.example/dune.jpg',
            format: null,
            textKind: 'ORIGINAL',
            lang: 'uk',
            translator: null,
            revision: 1,
          },
          work: {
            id: 'work-1',
            title: 'Дюна',
            origLang: 'en',
            firstPubYear: 1965,
            description: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            revision: 1,
          },
          authors: [
            { id: 'a-1', name: 'Френк Герберт', nameLatin: null, role: 'AUTHOR', position: 0 },
          ],
          place: { kind: 'HOME' },
        },
      ],
      total: 86,
    },
    friends: { items: [ANDRII], total: 23 },
    activity: [],
  }

  it('готові секції: підписи статистики за числом, картка книжки, друзі з адресою', () => {
    const view = toProfileSummaryView(
      { data: summary, error: null, isError: false, isFetching: false },
      NOW,
    )

    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return

    expect(view.stats.map((stat) => `${stat.value} ${stat.label}`)).toEqual([
      '86 книжок у бібліотеці',
      '23 друзі',
      '41 позика друзям',
      '12 у вішлисті',
    ])
    expect(view.books.cards).toEqual([
      {
        key: 'copy-1',
        bookId: 'work-1',
        title: 'Дюна',
        authors: 'Френк Герберт',
        coverUrl: 'https://img.example/dune.jpg',
        href: '/library/copy-1',
        place: { text: 'Вдома', tone: 'home' },
        ariaLabel: 'Дюна, Френк Герберт. Вдома',
      },
    ])
    expect(view.friends).toEqual({
      items: [{ key: 'user-2', user: ANDRII, href: '/u/andrii' }],
      total: 23,
    })
  })

  it('поки немає даних — завантаження; помилка — лише коли запит устиг завершитися', () => {
    const failure = new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' })

    expect(
      toProfileSummaryView({ data: undefined, error: null, isError: false, isFetching: true }, NOW),
    ).toEqual({ kind: 'loading' })
    expect(
      toProfileSummaryView({ data: summary, error: failure, isError: true, isFetching: true }, NOW),
    ).toEqual({ kind: 'loading' })
    expect(
      toProfileSummaryView(
        { data: summary, error: failure, isError: true, isFetching: false },
        NOW,
      ),
    ).toEqual({
      kind: 'error',
      message: expect.stringMatching(/^Не вдалося завантажити зведення профілю\./) as unknown,
    })
  })
})
