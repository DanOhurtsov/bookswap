import {
  anonymousHistoryEntrySchema,
  copyHistoryResponseSchema,
  historyCopySchema,
  historyEntrySchema,
  namedHistoryEntrySchema,
} from './history'

/**
 * §6.6 і §9: приватне не має **існувати** у відповіді, а не ховатися в UI.
 * Тому нижче перевіряється відсутність ключів, а не їхнє значення.
 */

const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: null }

const facts = {
  status: 'RETURNED',
  origin: 'REQUESTED',
  isOverdue: false,
  requestedAt: '2026-06-01T10:00:00.000Z',
  respondedAt: '2026-06-02T10:00:00.000Z',
  handedAt: '2026-06-03T10:00:00.000Z',
  returnedAt: '2026-06-10T10:00:00.000Z',
  dueAt: '2026-06-12',
}

const rawNamed = { ...facts, names: true, loanId: 'loan-1', owner: MARTA, borrower: OLES }

/** Усе, чим можна відновити особу або склеїти два зрізи історії. */
const IDENTIFYING_KEYS = [
  'owner',
  'borrower',
  'ownerId',
  'borrowerId',
  'currentHolder',
  'currentHolderId',
  'holder',
  'loanId',
]

describe('namedHistoryEntrySchema', () => {
  it('несе обидві сторони й id лоану', () => {
    const entry = namedHistoryEntrySchema.parse(rawNamed)

    expect(entry.owner).toEqual(MARTA)
    expect(entry.borrower).toEqual(OLES)
    expect(entry.loanId).toBe('loan-1')
  })

  it('вимагає names: true — прапорець частина контракту, а не підказка', () => {
    expect(namedHistoryEntrySchema.safeParse({ ...rawNamed, names: false }).success).toBe(false)
  })
})

describe('anonymousHistoryEntrySchema', () => {
  it('зрізає ВСЕ, чим можна відновити особу (§6.6)', () => {
    const entry = anonymousHistoryEntrySchema.parse({ ...rawNamed, names: false })

    for (const key of IDENTIFYING_KEYS) {
      expect(entry).not.toHaveProperty(key)
    }
  })

  it('у сирому JSON не лишається ані імен, ані ідентифікаторів', () => {
    const raw = JSON.stringify(anonymousHistoryEntrySchema.parse({ ...rawNamed, names: false }))

    expect(raw).not.toContain('Марта')
    expect(raw).not.toContain('user-oles')
    expect(raw).not.toContain('loan-1')
  })

  it('лишає факти — «у когось до 12 червня»', () => {
    const entry = anonymousHistoryEntrySchema.parse({ ...rawNamed, names: false })

    expect(entry.status).toBe('RETURNED')
    expect(entry.dueAt).toBe('2026-06-12')
  })
})

describe('historyEntrySchema', () => {
  it('розрізняє проєкції за names — клієнт звужує тип одним порівнянням', () => {
    const named = historyEntrySchema.parse(rawNamed)
    const anonymous = historyEntrySchema.parse({ ...rawNamed, names: false })

    expect(named.names).toBe(true)
    expect(anonymous.names).toBe(false)

    // Саме тут дискримінований union окупається: гілка `false` не має полів з
    // іменами навіть на рівні типів, тож прочитати їх неможливо.
    if (anonymous.names) throw new Error('Недосяжно')
    expect(anonymous).not.toHaveProperty('borrower')
  })

  it('без прапорця запис не приймається взагалі', () => {
    expect(historyEntrySchema.safeParse(facts).success).toBe(false)
  })
})

describe('historyCopySchema', () => {
  const rawCopy = {
    id: 'copy-1',
    status: 'AVAILABLE',
    condition: 'GOOD',
    // Те, чого в контракті бути не повинно:
    ownerId: 'user-marta',
    currentHolderId: 'user-marta',
    owner: MARTA,
    note: 'ПРИВАТНА НОТАТКА',
    edition: {
      id: 'edition-1',
      workId: 'work-1',
      translationId: null,
      publisher: 'КСД',
      year: 2019,
      isbn13: null,
      pageCount: 800,
      coverUrl: null,
      format: 'HARDCOVER',
      lang: 'en',
      translator: null,
      revision: 1,
    },
    work: {
      id: 'work-1',
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
  }

  it('не несе власника: чия це полиця, викликач знає зі сторінки', () => {
    // Інакше id власника у відповіді був би каналом витоку рівно тоді, коли
    // імена приховані.
    const copy = historyCopySchema.parse(rawCopy)

    expect(copy).not.toHaveProperty('ownerId')
    expect(copy).not.toHaveProperty('currentHolderId')
    expect(copy).not.toHaveProperty('owner')
    expect(copy).not.toHaveProperty('note')
  })

  it('несе каталожний контекст — інакше історія була б списком дат', () => {
    const copy = historyCopySchema.parse(rawCopy)

    expect(copy.work.title).toBe('Шантарам')
    expect(copy.edition.publisher).toBe('КСД')
  })

  it('відповідь історії примірника не має власника й на верхньому рівні', () => {
    const response = copyHistoryResponseSchema.parse({
      copy: rawCopy,
      entries: [{ ...rawNamed, names: false }],
    })

    expect(response).not.toHaveProperty('owner')
    expect(JSON.stringify(response)).not.toContain('user-marta')
  })
})

describe('requestedAt (Stage 10, T2)', () => {
  it('допускає null для записаних власником позик — запиту не було', () => {
    expect(
      historyEntrySchema.parse({ ...facts, requestedAt: null, names: false }).requestedAt,
    ).toBeNull()
  })

  it('усе ще відхиляє некоректну дату', () => {
    expect(
      historyEntrySchema.safeParse({ ...facts, requestedAt: '2026-06-01', names: false }).success,
    ).toBe(false)
  })
})
