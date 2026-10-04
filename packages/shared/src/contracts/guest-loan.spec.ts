import {
  createGuestLoanRequestSchema,
  guestLoanContactSchema,
  guestLoanResponseSchema,
  guestLoanSchema,
  updateGuestLoanRequestSchema,
} from './guest-loan'

const rawGuestLoan = {
  id: 'guest-loan-1',
  status: 'HANDED_OVER',
  evidence: 'OWNER_STATEMENT',
  isOverdue: false,
  createdAt: '2026-06-01T10:00:00.000Z',
  handedAt: '2026-06-01T00:00:00.000Z',
  returnedAt: null,
  dueAt: '2026-06-12',
  copy: {
    id: 'copy-1',
    status: 'LENT_OUT',
    condition: 'GOOD',
    isArchived: false,
  },
  edition: {
    id: 'edition-1',
    workId: 'work-1',
    translationId: null,
    publisher: 'КСД',
    year: 2019,
    isbn13: null,
    pageCount: 800,
    coverUrl: null,
    format: 'PAPERBACK',
    textKind: 'ORIGINAL',
    lang: 'uk',
    translator: null,
    revision: 1,
  },
  work: {
    id: 'work-1',
    title: 'Тестовий твір',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [
    { id: 'author-1', name: 'Тестовий Автор', nameLatin: null, role: 'AUTHOR', position: 0 },
  ],
  contact: { id: 'contact-1', alias: 'Гість' },
  recovery: null,
  lossClosure: null,
}

describe('guestLoanSchema (Stage 10, 10f.3)', () => {
  it('приймає повний, валідний гостьовий лоан із контактом', () => {
    expect(guestLoanSchema.safeParse(rawGuestLoan).success).toBe(true)
  })

  it('contact може бути null (D3/Q3d: контакт стерто, факт лишається)', () => {
    expect(guestLoanSchema.safeParse({ ...rawGuestLoan, contact: null }).success).toBe(true)
  })

  it('відхиляє owner/borrower/message/requestedAt — цього поля в контракті немає взагалі', () => {
    for (const extra of [
      { owner: { id: 'x', displayName: 'X', avatarUrl: null } },
      { borrower: { id: 'x', displayName: 'X', avatarUrl: null } },
      { message: 'привіт' },
      { requestedAt: '2026-06-01T10:00:00.000Z' },
      { note: 'ПРИВАТНЕ' },
    ]) {
      expect(guestLoanSchema.safeParse({ ...rawGuestLoan, ...extra }).success).toBe(false)
    }
  })

  it('status обмежений трьома значеннями — REQUESTED/APPROVED/PENDING_CONFIRMATION/CANCELLED/DECLINED неможливі', () => {
    for (const status of [
      'REQUESTED',
      'APPROVED',
      'PENDING_CONFIRMATION',
      'CANCELLED',
      'DECLINED',
    ]) {
      expect(guestLoanSchema.safeParse({ ...rawGuestLoan, status }).success).toBe(false)
    }

    for (const status of ['HANDED_OVER', 'RETURNED', 'LOST']) {
      expect(guestLoanSchema.safeParse({ ...rawGuestLoan, status }).success).toBe(true)
    }
  })

  it('recovery і lossClosure можуть співіснувати (Q3c: recover дозволений і після LOSS_CLOSED)', () => {
    const both = {
      ...rawGuestLoan,
      status: 'LOST',
      recovery: { effectiveAt: '2026-06-05T00:00:00.000Z', recordedAt: '2026-06-05T10:00:00.000Z' },
      lossClosure: { recordedAt: '2026-06-04T10:00:00.000Z' },
    }

    expect(guestLoanSchema.safeParse(both).success).toBe(true)
  })

  it('evidence (10i.1): лише OWNER_STATEMENT або GUEST_CONFIRMED, поле обовʼязкове', () => {
    expect(
      guestLoanSchema.safeParse({ ...rawGuestLoan, evidence: 'GUEST_CONFIRMED' }).success,
    ).toBe(true)

    for (const evidence of ['AWAITING_GUEST', 'GUEST_DENIED', 'CANCELLED', null]) {
      expect(guestLoanSchema.safeParse({ ...rawGuestLoan, evidence }).success).toBe(false)
    }

    const { evidence: _omitted, ...withoutEvidence } = rawGuestLoan

    expect(guestLoanSchema.safeParse(withoutEvidence).success).toBe(false)
  })

  it('lossClosure не має effectiveAt (§6.11.1: клієнтська дата закриття не приймається)', () => {
    const withClientDate = {
      ...rawGuestLoan,
      status: 'LOST',
      lossClosure: { recordedAt: '2026-06-04T10:00:00.000Z', effectiveAt: '2026-06-01' },
    }

    expect(guestLoanSchema.safeParse(withClientDate).success).toBe(false)
  })
})

describe('guestLoanContactSchema', () => {
  it('приймає {id, alias} або null; відхиляє зайві поля (email, ownerId)', () => {
    expect(guestLoanContactSchema.safeParse({ id: 'c-1', alias: 'Гість' }).success).toBe(true)
    expect(guestLoanContactSchema.safeParse(null).success).toBe(true)
    expect(
      guestLoanContactSchema.safeParse({ id: 'c-1', alias: 'Гість', email: 'x@example.com' })
        .success,
    ).toBe(false)
    expect(
      guestLoanContactSchema.safeParse({ id: 'c-1', alias: 'Гість', ownerId: 'u-1' }).success,
    ).toBe(false)
  })
})

describe('createGuestLoanRequestSchema', () => {
  const base = { copyId: 'copy-1', externalBorrowerId: 'contact-1', handedAt: '2026-06-01' }

  it('приймає мінімальне й повне тіло', () => {
    expect(createGuestLoanRequestSchema.safeParse(base).success).toBe(true)
    expect(createGuestLoanRequestSchema.safeParse({ ...base, dueAt: '2026-06-12' }).success).toBe(
      true,
    )
  })

  it('dueAt раніше handedAt — відхилено', () => {
    expect(createGuestLoanRequestSchema.safeParse({ ...base, dueAt: '2026-05-01' }).success).toBe(
      false,
    )
  })

  it('borrowerId (реєстрований позичальник) і message — зайві поля, strict відхиляє', () => {
    expect(createGuestLoanRequestSchema.safeParse({ ...base, borrowerId: 'u-1' }).success).toBe(
      false,
    )
    expect(createGuestLoanRequestSchema.safeParse({ ...base, message: 'x' }).success).toBe(false)
  })
})

describe('updateGuestLoanRequestSchema', () => {
  it('return/mark_lost/recover/close_loss — усі дозволені дії', () => {
    for (const action of ['return', 'mark_lost', 'recover', 'close_loss']) {
      expect(updateGuestLoanRequestSchema.safeParse({ action }).success).toBe(true)
    }
  })

  it('дії request-flow/запису неможливі синтаксично', () => {
    for (const action of ['approve', 'confirm_record', 'hand_over', 'reject', 'amend_record']) {
      expect(updateGuestLoanRequestSchema.safeParse({ action }).success).toBe(false)
    }
  })

  it('effectiveAt лише з recover', () => {
    expect(
      updateGuestLoanRequestSchema.safeParse({ action: 'recover', effectiveAt: '2026-06-01' })
        .success,
    ).toBe(true)
    expect(
      updateGuestLoanRequestSchema.safeParse({ action: 'close_loss', effectiveAt: '2026-06-01' })
        .success,
    ).toBe(false)
  })

  it('note — зайве поле, strict відхиляє (D1: вільний текст для гостя заборонений)', () => {
    expect(
      updateGuestLoanRequestSchema.safeParse({ action: 'return', note: 'знайшла під диваном' })
        .success,
    ).toBe(false)
  })
})

describe('guestLoanResponseSchema', () => {
  it('strict: жодного поля поза {loan}', () => {
    expect(guestLoanResponseSchema.safeParse({ loan: rawGuestLoan }).success).toBe(true)
    expect(guestLoanResponseSchema.safeParse({ loan: rawGuestLoan, ownerId: 'u-1' }).success).toBe(
      false,
    )
  })
})
