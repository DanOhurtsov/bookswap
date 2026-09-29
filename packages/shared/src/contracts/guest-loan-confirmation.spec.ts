import { guestLoanEvidenceOf } from '../domain/loan'
import {
  createGuestLoanConfirmationRequestSchema,
  guestConfirmationContactSchema,
  guestLoanConfirmationListResponseSchema,
  guestLoanConfirmationResponseSchema,
  guestLoanConfirmationSchema,
  updateGuestLoanConfirmationRequestSchema,
} from './guest-loan-confirmation'

/** Stage 10, 10i.1: owner-only ресурс запиту гостьового підтвердження. Лише синтетичні дані. */

const rawConfirmation = {
  id: 'gc-1',
  status: 'OPEN',
  evidence: 'AWAITING_GUEST',
  createdAt: '2026-09-29T10:00:00.000Z',
  resolvedAt: null,
  loan: {
    id: 'l-1',
    status: 'PENDING_CONFIRMATION',
    isOverdue: false,
    createdAt: '2026-09-29T10:00:00.000Z',
    handedAt: '2026-09-29T00:00:00.000Z',
    returnedAt: null,
    dueAt: null,
  },
  copy: { id: 'c-1', status: 'RESERVED', condition: 'GOOD', isArchived: false },
  edition: {
    id: 'e-1',
    workId: 'w-1',
    translationId: null,
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    lang: 'uk',
    translator: null,
    revision: 1,
  },
  work: {
    id: 'w-1',
    title: 'Т',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  contact: {
    id: 'eb-1',
    alias: 'Гість',
    guestNickname: null,
    guestEmail: null,
    guestEmailVerifiedAt: null,
  },
}

describe('guestLoanConfirmationSchema', () => {
  it('приймає відкритий запит із контактом без підтверджених даних', () => {
    expect(guestLoanConfirmationSchema.safeParse(rawConfirmation).success).toBe(true)
  })

  it('приймає підтверджені гостем нікнейм/email у контакті власника та contact = null', () => {
    const confirmed = {
      ...rawConfirmation,
      contact: {
        ...rawConfirmation.contact,
        guestNickname: 'Синтетичний',
        guestEmail: 'guest@guest.invalid',
        guestEmailVerifiedAt: '2026-09-29T10:00:00.000Z',
      },
    }

    expect(guestLoanConfirmationSchema.safeParse(confirmed).success).toBe(true)
    expect(
      guestLoanConfirmationSchema.safeParse({ ...rawConfirmation, contact: null }).success,
    ).toBe(true)
  })

  it('status позики обмежений п’ятьма значеннями', () => {
    for (const status of ['PENDING_CONFIRMATION', 'CANCELLED', 'HANDED_OVER', 'RETURNED', 'LOST']) {
      expect(
        guestLoanConfirmationSchema.safeParse({
          ...rawConfirmation,
          loan: { ...rawConfirmation.loan, status },
        }).success,
      ).toBe(true)
    }

    for (const status of ['REQUESTED', 'APPROVED', 'REJECTED', 'DECLINED']) {
      expect(
        guestLoanConfirmationSchema.safeParse({
          ...rawConfirmation,
          loan: { ...rawConfirmation.loan, status },
        }).success,
      ).toBe(false)
    }
  })

  it('strict: жодного owner/borrower/message/email поза контактом', () => {
    for (const extra of [
      { owner: { id: 'x' } },
      { borrower: { id: 'x' } },
      { message: 'привіт' },
      { email: 'x@guest.invalid' },
      { token: 'secret' },
    ]) {
      expect(guestLoanConfirmationSchema.safeParse({ ...rawConfirmation, ...extra }).success).toBe(
        false,
      )
    }
  })

  it('контакт відхиляє зайві поля', () => {
    expect(
      guestConfirmationContactSchema.safeParse({ ...rawConfirmation.contact, ownerId: 'u-1' })
        .success,
    ).toBe(false)
  })

  it('відповіді strict', () => {
    expect(
      guestLoanConfirmationResponseSchema.safeParse({ confirmation: rawConfirmation }).success,
    ).toBe(true)
    expect(
      guestLoanConfirmationResponseSchema.safeParse({ confirmation: rawConfirmation, extra: 1 })
        .success,
    ).toBe(false)
    expect(
      guestLoanConfirmationListResponseSchema.safeParse({ confirmations: [rawConfirmation] })
        .success,
    ).toBe(true)
  })
})

describe('запити', () => {
  it('create — ті самі поля, що POST /loans/guest; strict', () => {
    const body = { copyId: 'c-1', externalBorrowerId: 'eb-1', handedAt: '2026-09-01' }

    expect(createGuestLoanConfirmationRequestSchema.safeParse(body).success).toBe(true)
    expect(
      createGuestLoanConfirmationRequestSchema.safeParse({ ...body, email: 'x@guest.invalid' })
        .success,
    ).toBe(false)
    expect(
      createGuestLoanConfirmationRequestSchema.safeParse({ ...body, dueAt: '2026-08-01' }).success,
    ).toBe(false)
  })

  it('update: cancel_handover вимагає bookIsWithOwner: true', () => {
    const parse = (value: unknown): boolean =>
      updateGuestLoanConfirmationRequestSchema.safeParse(value).success

    expect(parse({ action: 'cancel_handover', bookIsWithOwner: true })).toBe(true)
    expect(parse({ action: 'cancel_handover' })).toBe(false)
    expect(parse({ action: 'cancel_handover', bookIsWithOwner: false })).toBe(false)
  })

  it('update: record_owner_statement — без додаткових полів', () => {
    const parse = (value: unknown): boolean =>
      updateGuestLoanConfirmationRequestSchema.safeParse(value).success

    expect(parse({ action: 'record_owner_statement' })).toBe(true)
    expect(parse({ action: 'record_owner_statement', bookIsWithOwner: true })).toBe(false)
    expect(parse({ action: 'reject' })).toBe(false)
  })
})

describe('guestLoanEvidenceOf', () => {
  it.each([
    [null, 'OWNER_STATEMENT'],
    ['OWNER_RECORDED', 'OWNER_STATEMENT'],
    ['OPEN', 'AWAITING_GUEST'],
    ['DENIED', 'GUEST_DENIED'],
    ['RECEIVED', 'GUEST_CONFIRMED'],
    ['CANCELLED', null],
  ] as const)('%s → %s', (status, evidence) => {
    expect(guestLoanEvidenceOf(status)).toBe(evidence)
  })
})
