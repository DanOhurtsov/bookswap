import {
  averageLoanDays,
  latestActivity,
  loanStepsOf,
  placeOf,
  toProfileBook,
  type ActivityLoanRow,
  type SummaryCopyLoanRow,
  type SummaryCopyRow,
} from './profile-summary.mapper'

const MARTA = { id: 'user-marta', displayName: 'Марта', handle: 'marta', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', handle: 'oles', avatarUrl: null }
const NOW = new Date('2026-10-27T12:00:00.000Z')

function copyRow(overrides: Partial<SummaryCopyRow> = {}): SummaryCopyRow {
  return {
    id: 'copy-1',
    ownerId: MARTA.id,
    currentHolderId: MARTA.id,
    heldByContactId: null,
    status: 'AVAILABLE',
    currentHolder: MARTA,
    heldByContact: null,
    loans: [],
    edition: {
      id: 'edition-1',
      workId: 'work-1',
      translationId: null,
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: null,
      textKind: 'ORIGINAL',
      lang: 'uk',
      revision: 1,
      translation: null,
      work: {
        id: 'work-1',
        title: 'Тигролови',
        origLang: 'uk',
        firstPubYear: 1944,
        description: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        revision: 1,
        authors: [
          {
            role: 'AUTHOR',
            position: 0,
            author: { id: 'a-1', name: 'Іван Багряний', nameLatin: null },
          },
        ],
      },
    },
    ...overrides,
  }
}

function openLoan(overrides: Partial<SummaryCopyLoanRow> = {}): SummaryCopyLoanRow {
  return { status: 'REQUESTED', dueAt: null, borrower: OLES, borrowerContact: null, ...overrides }
}

/** Away from home with Oles (a registered borrower). */
const withOles = { currentHolderId: OLES.id, currentHolder: OLES }

/** Away from home with a guest contact: `currentHolderId` is NULL (Stage 10, T1-a). */
const withGuest = {
  currentHolderId: null,
  currentHolder: null,
  heldByContactId: 'contact-1',
  heldByContact: { alias: 'Сусідка Оля' },
}

describe('placeOf', () => {
  it('вільна вдома — HOME; з запитами — HOME_REQUESTED із їхньою кількістю', () => {
    expect(placeOf(copyRow(), NOW)).toEqual({ kind: 'HOME' })
    expect(placeOf(copyRow({ loans: [openLoan(), openLoan({ borrower: MARTA })] }), NOW)).toEqual({
      kind: 'HOME_REQUESTED',
      pendingRequestCount: 2,
    })
  })

  it('погоджений запит — RESERVED з тим, кому книжку обіцяно', () => {
    const place = placeOf(
      copyRow({ status: 'RESERVED', loans: [openLoan({ status: 'APPROVED' })] }),
      NOW,
    )

    expect(place).toEqual({ kind: 'RESERVED', borrower: { kind: 'USER', user: OLES } })
  })

  it('запис для гостя, що чекає підтвердження, — RESERVED з аліасом гостя', () => {
    const place = placeOf(
      copyRow({
        status: 'RESERVED',
        loans: [
          openLoan({
            status: 'PENDING_CONFIRMATION',
            borrower: null,
            borrowerContact: { alias: 'Сусідка Оля' },
          }),
        ],
      }),
      NOW,
    )

    expect(place).toEqual({ kind: 'RESERVED', borrower: { kind: 'GUEST', alias: 'Сусідка Оля' } })
  })

  it('власник не дає книжку — UNAVAILABLE', () => {
    expect(placeOf(copyRow({ status: 'UNAVAILABLE' }), NOW)).toEqual({ kind: 'UNAVAILABLE' })
  })

  it('у друга — LENT із днем повернення; прострочення рахує сервер', () => {
    const lent = (dueAt: Date | null) =>
      placeOf(
        copyRow({
          ...withOles,
          status: 'LENT_OUT',
          loans: [openLoan({ status: 'HANDED_OVER', dueAt })],
        }),
        NOW,
      )

    expect(lent(new Date('2026-11-02T23:59:59.999Z'))).toEqual({
      kind: 'LENT',
      holder: { kind: 'USER', user: OLES },
      dueAt: '2026-11-02',
      overdue: false,
    })
    expect(lent(new Date('2026-10-26T23:59:59.999Z'))).toMatchObject({ overdue: true })
    expect(lent(null)).toMatchObject({ dueAt: null, overdue: false })
  })

  it('у гостя — LENT з аліасом; після стирання контакту — без імені', () => {
    const atGuest = placeOf(copyRow({ ...withGuest, status: 'LENT_OUT' }), NOW)
    const erased = placeOf(
      copyRow({
        ...withGuest,
        heldByContactId: null,
        heldByContact: null,
        status: 'LENT_OUT',
      }),
      NOW,
    )

    expect(atGuest).toMatchObject({ kind: 'LENT', holder: { kind: 'GUEST', alias: 'Сусідка Оля' } })
    expect(erased).toMatchObject({ kind: 'LENT', holder: { kind: 'GUEST', alias: null } })
  })

  it('втрачена — LOST з тим, у кого вона лишилася, а не «вдома»', () => {
    expect(placeOf(copyRow({ ...withOles, status: 'UNAVAILABLE' }), NOW)).toEqual({
      kind: 'LOST',
      holder: { kind: 'USER', user: OLES },
    })
  })
})

describe('toProfileBook', () => {
  it('несе каталожний контекст і місце примірника', () => {
    const book = toProfileBook(copyRow(), NOW)

    expect(book.copyId).toBe('copy-1')
    expect(book.work.title).toBe('Тигролови')
    expect(book.authors.map((author) => author.name)).toEqual(['Іван Багряний'])
    expect(book.place).toEqual({ kind: 'HOME' })
  })
})

function loanRow(overrides: Partial<ActivityLoanRow> = {}): ActivityLoanRow {
  return {
    id: 'loan-1',
    ownerId: MARTA.id,
    origin: 'REQUESTED',
    status: 'REQUESTED',
    requestedAt: new Date('2026-10-01T10:00:00.000Z'),
    respondedAt: null,
    handedAt: null,
    returnedAt: null,
    owner: MARTA,
    borrower: OLES,
    borrowerContact: null,
    copy: { edition: { work: { id: 'work-1', title: 'Тигролови' } } },
    ...overrides,
  }
}

describe('loanStepsOf', () => {
  it('повний шлях запиту: запит → погодження → передача → повернення', () => {
    const steps = loanStepsOf(
      loanRow({
        status: 'RETURNED',
        respondedAt: new Date('2026-10-02T10:00:00.000Z'),
        handedAt: new Date('2026-10-03T10:00:00.000Z'),
        returnedAt: new Date('2026-10-20T10:00:00.000Z'),
      }),
    )

    expect(steps.map((step) => step.event)).toEqual([
      'REQUESTED',
      'APPROVED',
      'HANDED_OVER',
      'RETURNED',
    ])
  })

  it('відповідь на відхилений запит — REJECTED, а не погодження', () => {
    const steps = loanStepsOf(
      loanRow({ status: 'REJECTED', respondedAt: new Date('2026-10-02T10:00:00.000Z') }),
    )

    expect(steps.map((step) => step.event)).toEqual(['REQUESTED', 'REJECTED'])
  })

  it('записана позика не має запиту; непідтверджений запис — ще не передача', () => {
    const recorded = {
      origin: 'RECORDED_EXISTING' as const,
      requestedAt: null,
      handedAt: new Date('2026-09-01T00:00:00.000Z'),
    }

    expect(
      loanStepsOf(loanRow({ ...recorded, status: 'HANDED_OVER' })).map((s) => s.event),
    ).toEqual(['HANDED_OVER'])
    expect(loanStepsOf(loanRow({ ...recorded, status: 'PENDING_CONFIRMATION' }))).toEqual([])
    expect(loanStepsOf(loanRow({ ...recorded, status: 'DECLINED' }))).toEqual([])
  })
})

describe('latestActivity', () => {
  it('найновіші спершу, у межах ліміту; позика з кількох запитів — один раз', () => {
    const handed = loanRow({
      status: 'HANDED_OVER',
      respondedAt: new Date('2026-10-02T10:00:00.000Z'),
      handedAt: new Date('2026-10-03T10:00:00.000Z'),
    })
    const activity = latestActivity(
      [handed, handed],
      [{ count: 3, at: new Date('2026-10-02T18:00:00.000Z') }],
      MARTA.id,
      3,
    )

    expect(activity.map((line) => (line.kind === 'LOAN' ? line.event : line.kind))).toEqual([
      'HANDED_OVER',
      'COPIES_ADDED',
      'APPROVED',
    ])
  })

  it('власникові інша сторона — позичальник, позичальникові — власник', () => {
    const loan = loanRow()

    expect(latestActivity([loan], [], MARTA.id, 5)[0]).toMatchObject({
      role: 'OWNER',
      counterpart: { kind: 'USER', user: OLES },
    })
    expect(latestActivity([loan], [], OLES.id, 5)[0]).toMatchObject({
      role: 'BORROWER',
      counterpart: { kind: 'USER', user: MARTA },
    })
  })

  it('гостьова позика називає гостя аліасом власника', () => {
    const guest = loanRow({
      origin: 'RECORDED_GUEST',
      status: 'HANDED_OVER',
      requestedAt: null,
      handedAt: new Date('2026-10-05T00:00:00.000Z'),
      borrower: null,
      borrowerContact: { alias: 'Сусідка Оля' },
    })

    expect(latestActivity([guest], [], MARTA.id, 5)).toEqual([
      {
        kind: 'LOAN',
        event: 'HANDED_OVER',
        at: '2026-10-05T00:00:00.000Z',
        loanId: 'loan-1',
        role: 'OWNER',
        counterpart: { kind: 'GUEST', alias: 'Сусідка Оля' },
        work: { id: 'work-1', title: 'Тигролови' },
      },
    ])
  })
})

describe('averageLoanDays', () => {
  it('округлює до цілого дня; без повернень — null', () => {
    expect(averageLoanDays(null)).toBeNull()
    expect(averageLoanDays(14.4 * 86_400)).toBe(14)
    expect(averageLoanDays(14.6 * 86_400)).toBe(15)
  })
})
