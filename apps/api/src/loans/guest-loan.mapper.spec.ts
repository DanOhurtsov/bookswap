import {
  asGuestLoan,
  GUEST_LOAN_STATUSES,
  toGuestLoan,
  type GuestLoanRow,
  type UnvalidatedGuestLoanRow,
} from './guest-loan.mapper'
import type { LoanStatus } from '@bookswap/shared'

/**
 * Stage 10 (10f.3, рев'ю): CHECK `loan_borrower_kind_valid` не обмежує `status` — межу тримає
 * лише код читачів. Тест доводить, що `asGuestLoan` справді відкидає все, чого немає в
 * `GUEST_LOAN_STATUSES`, а не покладається на припущення, що такого рядка не буває.
 */

const BASE = {
  id: 'l-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  returnedAt: null,
  dueAt: null,
  copy: {
    id: 'c-1',
    status: 'LENT_OUT',
    condition: 'GOOD',
    archivedAt: null,
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
      work: {
        id: 'w-1',
        title: 'Т',
        origLang: 'uk',
        firstPubYear: null,
        description: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        revision: 1,
        authors: [],
      },
    },
  },
  borrowerContact: { id: 'eb-1', alias: 'Гість' },
  events: [],
  guestConfirmation: null,
} as const

function row(status: LoanStatus, handedAt: Date | null): UnvalidatedGuestLoanRow {
  return { ...BASE, status, handedAt } as unknown as UnvalidatedGuestLoanRow
}

describe('GUEST_LOAN_STATUSES / asGuestLoan (Stage 10, 10f.3)', () => {
  it('точно три значення — HANDED_OVER, RETURNED, LOST', () => {
    expect([...GUEST_LOAN_STATUSES].sort()).toEqual(['HANDED_OVER', 'LOST', 'RETURNED'])
  })

  it.each(['HANDED_OVER', 'RETURNED', 'LOST'] as const)(
    '%s із handedAt — валідний гостьовий рядок',
    (status) => {
      expect(asGuestLoan(row(status, new Date()))).not.toBeNull()
    },
  )

  it.each([
    'REQUESTED',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'PENDING_CONFIRMATION',
    'DECLINED',
  ] as const)(
    '%s — синтетичний/зіпсований рядок, CHECK його не забороняє, але читач відкидає',
    (status) => {
      expect(asGuestLoan(row(status, new Date()))).toBeNull()
    },
  )

  it('handedAt = null відхиляється навіть для легітимного статусу', () => {
    expect(asGuestLoan(row('HANDED_OVER', null))).toBeNull()
    expect(asGuestLoan(row('LOST', null))).toBeNull()
  })
})

describe('toGuestLoan.evidence (Stage 10, 10i.1): виводиться з рядка підтвердження', () => {
  const active = (confirmation: { status: string } | null): GuestLoanRow =>
    ({
      ...BASE,
      status: 'HANDED_OVER',
      handedAt: new Date('2026-01-02T00:00:00.000Z'),
      guestConfirmation: confirmation,
    }) as unknown as GuestLoanRow

  it('старий ручний запис 10f.3 (без рядка підтвердження) — зі слів власника', () => {
    expect(toGuestLoan(active(null)).evidence).toBe('OWNER_STATEMENT')
  })

  it('OWNER_RECORDED — зі слів власника, а не «підтверджено гостем»', () => {
    expect(toGuestLoan(active({ status: 'OWNER_RECORDED' })).evidence).toBe('OWNER_STATEMENT')
  })

  it('RECEIVED — підтверджено гостем', () => {
    expect(toGuestLoan(active({ status: 'RECEIVED' })).evidence).toBe('GUEST_CONFIRMED')
  })

  it.each(['OPEN', 'DENIED', 'CANCELLED'])(
    'статус підтвердження %s несумісний з активною позикою — падає гучно',
    (status) => {
      expect(() => toGuestLoan(active({ status }))).toThrow(/цілісність даних порушена/)
    },
  )

  it('контракт не віддає нікнейм/email гостя', () => {
    const raw = JSON.stringify(toGuestLoan(active({ status: 'RECEIVED' })))

    expect(raw).not.toMatch(/guestNickname|guestEmail/)
  })
})
