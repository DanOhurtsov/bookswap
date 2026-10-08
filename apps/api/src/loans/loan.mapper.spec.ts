import {
  asServedLoan,
  isOverdue,
  toDueDate,
  toIsoDay,
  toLoan,
  type LoanRow,
  type StoredLoanRow,
} from './loan.mapper'

/**
 * §5.2: «`OVERDUE` — не статус». Прострочення виводиться, і саме тому його межі
 * перевіряються тут — чистою функцією, без бази й без годинника тестового runner'а.
 */

const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: null }

const NOW = new Date('2026-06-15T12:00:00.000Z')

function loanRow(overrides: Partial<LoanRow> = {}): LoanRow {
  return {
    id: 'loan-1',
    origin: 'REQUESTED',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    status: 'HANDED_OVER',
    message: 'дуже хочу почитати',
    responseNote: null,
    requestedAt: new Date('2026-06-01T10:00:00.000Z'),
    respondedAt: new Date('2026-06-02T10:00:00.000Z'),
    handedAt: new Date('2026-06-03T10:00:00.000Z'),
    returnedAt: null,
    dueAt: null,
    owner: MARTA,
    borrower: OLES,
    copy: {
      id: 'copy-1',
      status: 'LENT_OUT',
      condition: 'GOOD',
      archivedAt: null,
      edition: {
        id: 'edition-1',
        workId: 'work-1',
        translationId: 'translation-1',
        publisher: 'КСД',
        year: 2019,
        isbn13: null,
        pageCount: 800,
        coverUrl: null,
        format: 'HARDCOVER',
        textKind: 'TRANSLATION',
        lang: 'uk',
        revision: 1,
        translation: { lang: 'uk', translator: 'Любов Пилаєва' },
        work: {
          id: 'work-1',
          title: 'Шантарам',
          origLang: 'en',
          firstPubYear: 2003,
          description: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          revision: 1,
          authors: [
            {
              role: 'AUTHOR',
              position: 0,
              author: { id: 'a-1', name: 'Ґреґорі Робертс', nameLatin: null },
            },
          ],
        },
      },
    },
    events: [],
    ...overrides,
  }
}

describe('toDueDate', () => {
  it('розгортає день у кінець доби — «до 12 червня» включає 12-те', () => {
    // З опівніччю людина ставала б боржником зранку того самого дня, який сама ж
    // і назвала.
    expect(toDueDate('2026-06-12')?.toISOString()).toBe('2026-06-12T23:59:59.999Z')
  })

  it('порожній термін лишається порожнім', () => {
    expect(toDueDate(null)).toBeNull()
    expect(toDueDate(undefined)).toBeNull()
  })

  it('туди й назад дає той самий день', () => {
    expect(toIsoDay(toDueDate('2026-06-12'))).toBe('2026-06-12')
  })
})

describe('isOverdue', () => {
  it('до кінця вказаного дня прострочення немає', () => {
    const dueToday = loanRow({ dueAt: toDueDate('2026-06-15') })

    expect(isOverdue(dueToday, NOW)).toBe(false)
  })

  it('наступного дня прострочення є', () => {
    const dueYesterday = loanRow({ dueAt: toDueDate('2026-06-14') })

    expect(isOverdue(dueYesterday, NOW)).toBe(true)
  })

  it('без терміну прострочення не буває', () => {
    expect(isOverdue(loanRow({ dueAt: null }), NOW)).toBe(false)
  })

  it('прострочення можливе лише в HANDED_OVER', () => {
    // §5.2: книжка на руках — єдиний стан, у якому «не повернув» щось означає.
    // Ані домовленість, ані вже повернена книжка простроченими не бувають.
    const overdueDate = toDueDate('2026-06-01')

    expect(isOverdue(loanRow({ status: 'APPROVED', dueAt: overdueDate }), NOW)).toBe(false)
    expect(isOverdue(loanRow({ status: 'RETURNED', dueAt: overdueDate }), NOW)).toBe(false)
    expect(isOverdue(loanRow({ status: 'LOST', dueAt: overdueDate }), NOW)).toBe(false)
    expect(isOverdue(loanRow({ status: 'REQUESTED', dueAt: overdueDate }), NOW)).toBe(false)
  })
})

describe('toLoan', () => {
  it('віддає обидві сторони: без імені немає кому вертати книжку', () => {
    const loan = toLoan(loanRow(), NOW)

    expect(loan.owner).toEqual(MARTA)
    expect(loan.borrower).toEqual(OLES)
  })

  it('не віддає приватного власника: нотатки, дати придбання, видимості', () => {
    // Домовленість про конкретну книжку не дає доступу до записів власника про неї.
    const loan = toLoan(loanRow(), NOW)

    expect(loan.copy).not.toHaveProperty('note')
    expect(loan.copy).not.toHaveProperty('acquiredAt')
    expect(loan.copy).not.toHaveProperty('visibility')
    expect(loan.copy).not.toHaveProperty('ownerId')
    expect(loan.copy).not.toHaveProperty('currentHolderId')
  })

  it('термін повернення віддається днем, решта позначок — повним часом', () => {
    const loan = toLoan(loanRow({ dueAt: toDueDate('2026-06-20') }), NOW)

    expect(loan.dueAt).toBe('2026-06-20')
    expect(loan.requestedAt).toBe('2026-06-01T10:00:00.000Z')
    expect(loan.handedAt).toBe('2026-06-03T10:00:00.000Z')
    expect(loan.returnedAt).toBeNull()
  })

  it('прострочення рахує сервер, а не клієнт', () => {
    expect(toLoan(loanRow({ dueAt: toDueDate('2026-06-01') }), NOW).isOverdue).toBe(true)
    expect(toLoan(loanRow({ dueAt: toDueDate('2026-06-30') }), NOW).isOverdue).toBe(false)
  })

  it('факт знахідки: effectiveAt із події, recordedAt — момент запису; без події — null', () => {
    expect(toLoan(loanRow({ status: 'LOST' }), NOW).recovery).toBeNull()

    const recovered = toLoan(
      loanRow({
        status: 'LOST',
        events: [
          {
            occurredAt: new Date('2026-06-14T09:00:00.000Z'),
            effectiveAt: new Date('2026-06-10T00:00:00.000Z'),
          },
        ],
      }),
      NOW,
    )

    expect(recovered.status).toBe('LOST')
    expect(recovered.recovery).toEqual({
      effectiveAt: '2026-06-10T00:00:00.000Z',
      recordedAt: '2026-06-14T09:00:00.000Z',
    })
  })

  it('без окремої фактичної дати effectiveAt дорівнює моменту запису', () => {
    const loan = toLoan(
      loanRow({
        status: 'LOST',
        events: [{ occurredAt: new Date('2026-06-14T09:00:00.000Z'), effectiveAt: null }],
      }),
      NOW,
    )

    expect(loan.recovery?.effectiveAt).toBe('2026-06-14T09:00:00.000Z')
  })

  it('архівність примірника віддається прапорцем без дати', () => {
    expect(toLoan(loanRow(), NOW).copy.isArchived).toBe(false)

    const archived = loanRow()

    archived.copy.archivedAt = new Date('2026-06-05T00:00:00.000Z')

    const loan = toLoan(archived, NOW)

    expect(loan.copy.isArchived).toBe(true)
    expect(loan.copy).not.toHaveProperty('archivedAt')
  })

  it('несе каталожний контекст: без нього список лоанів — це список id', () => {
    const loan = toLoan(loanRow(), NOW)

    expect(loan.work.title).toBe('Шантарам')
    expect(loan.edition.lang).toBe('uk')
    expect(loan.authors[0]?.name).toBe('Ґреґорі Робертс')
  })
})

describe('toLoan: записана власником позика (Stage 10, 10e)', () => {
  it('requestedAt = null і origin визначає підпис; createdAt — момент запису', () => {
    const loan = toLoan(
      loanRow({
        origin: 'RECORDED_EXISTING',
        status: 'PENDING_CONFIRMATION',
        requestedAt: null,
        respondedAt: null,
        message: null,
        createdAt: new Date('2026-06-14T09:00:00.000Z'),
        handedAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
      NOW,
    )

    expect(loan.origin).toBe('RECORDED_EXISTING')
    expect(loan.requestedAt).toBeNull()
    expect(loan.createdAt).toBe('2026-06-14T09:00:00.000Z')
    expect(loan.handedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(loan.isOverdue).toBe(false)
  })

  it('після підтвердження прострочений строк дає isOverdue', () => {
    const loan = toLoan(
      loanRow({ origin: 'RECORDED_EXISTING', requestedAt: null, dueAt: toDueDate('2026-06-01') }),
      NOW,
    )

    expect(loan.isOverdue).toBe(true)
  })
})

describe('asServedLoan (Stage 10, 10e): межі origin', () => {
  const stored = (overrides: Partial<StoredLoanRow>): StoredLoanRow => ({
    origin: 'RECORDED_EXISTING',
    borrowerKind: 'REGISTERED',
    borrowerId: OLES.id,
    borrower: OLES,
    status: 'PENDING_CONFIRMATION',
    requestedAt: null,
    handedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  })

  it('валідний запис проходить; requestedAt лишається null навіть за дефолту БД now()', () => {
    expect(asServedLoan(stored({}))).not.toBeNull()
    expect(asServedLoan(stored({ requestedAt: new Date() }))?.requestedAt).toBeNull()
  })

  it.each(['REQUESTED', 'APPROVED', 'REJECTED'] as const)(
    'синтетичний RECORDED_EXISTING зі статусом %s не легітимний',
    (status) => {
      expect(asServedLoan(stored({ status }))).toBeNull()
    },
  )

  it('запис без handedAt, гостьовий і RECORDED_GUEST не віддаються', () => {
    expect(asServedLoan(stored({ handedAt: null }))).toBeNull()
    expect(
      asServedLoan(stored({ borrowerKind: 'GUEST', borrowerId: null, borrower: null })),
    ).toBeNull()
    expect(asServedLoan(stored({ origin: 'RECORDED_GUEST' }))).toBeNull()
  })

  it.each(['PENDING_CONFIRMATION', 'DECLINED'] as const)(
    'request-flow позика зі статусом запису %s не легітимна',
    (status) => {
      expect(
        asServedLoan(stored({ origin: 'REQUESTED', status, requestedAt: new Date() })),
      ).toBeNull()
    },
  )

  it('request-flow без requestedAt не віддається', () => {
    expect(
      asServedLoan(stored({ origin: 'REQUESTED', status: 'REQUESTED', requestedAt: null })),
    ).toBeNull()
  })
})
