import { LOAN_ACTIONS, LOAN_STATUS } from '../domain/loan'
import {
  createLoanRequestSchema,
  createRecordedLoanRequestSchema,
  isRecordAction,
  loanQueryRequestSchema,
  loanSchema,
  updateLoanRequestSchema,
} from './loan'

const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: null }

const rawLoan = {
  id: 'loan-1',
  status: 'HANDED_OVER',
  origin: 'REQUESTED',
  createdAt: '2026-06-01T10:00:00.000Z',
  isOverdue: false,
  message: 'дуже хочу почитати',
  responseNote: null,
  requestedAt: '2026-06-01T10:00:00.000Z',
  respondedAt: '2026-06-02T10:00:00.000Z',
  handedAt: '2026-06-03T10:00:00.000Z',
  returnedAt: null,
  dueAt: '2026-06-12',
  owner: MARTA,
  borrower: OLES,
  copy: {
    id: 'copy-1',
    status: 'LENT_OUT',
    condition: 'GOOD',
    isArchived: false,
    // Приватне власника, якого в схемі бути не повинно:
    note: 'ПРИВАТНА НОТАТКА',
    visibility: 'PRIVATE',
    ownerId: 'user-marta',
    currentHolderId: 'user-oles',
  },
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
    lang: 'uk',
    translator: 'Любов Пилаєва',
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
  authors: [{ id: 'a-1', name: 'Ґреґорі Робертс', nameLatin: null, role: 'AUTHOR', position: 0 }],
  recovery: null,
}

describe('loanSchema', () => {
  it('несе обидві сторони — без імені немає кому вертати книжку', () => {
    const loan = loanSchema.parse(rawLoan)

    expect(loan.owner.displayName).toBe('Марта')
    expect(loan.borrower.displayName).toBe('Олесь')
  })

  it('примірник у лоані не несе приватного власника (§9)', () => {
    // Домовленість про книжку не дає доступу до записів власника про неї.
    const loan = loanSchema.parse(rawLoan)

    expect(loan.copy).not.toHaveProperty('note')
    expect(loan.copy).not.toHaveProperty('visibility')
    expect(loan.copy).not.toHaveProperty('ownerId')
    expect(loan.copy).not.toHaveProperty('currentHolderId')
  })

  it('термін повернення — день без часу, решта позначок — повний ISO', () => {
    expect(loanSchema.safeParse({ ...rawLoan, dueAt: '2026-06-12T00:00:00.000Z' }).success).toBe(
      false,
    )
    expect(loanSchema.safeParse({ ...rawLoan, requestedAt: '2026-06-01' }).success).toBe(false)
  })

  it('прострочення приходить прапорцем, а не статусом (§5.2)', () => {
    expect(loanSchema.parse(rawLoan).isOverdue).toBe(false)
    expect(loanSchema.safeParse({ ...rawLoan, status: 'OVERDUE' }).success).toBe(false)
  })

  it.each([...LOAN_STATUS])('приймає статус %s', (status) => {
    expect(loanSchema.parse({ ...rawLoan, status }).status).toBe(status)
  })

  it('факт знахідки — окреме поле; статус LOST лишається', () => {
    const recovery = { effectiveAt: '2026-09-20T00:00:00.000Z', recordedAt: '2026-09-26T09:00:00Z' }
    const loan = loanSchema.parse({ ...rawLoan, status: 'LOST', recovery })

    expect(loan.status).toBe('LOST')
    expect(loan.recovery).toEqual(recovery)
    expect(
      loanSchema.safeParse({ ...rawLoan, recovery: { effectiveAt: '2026-09-20' } }).success,
    ).toBe(false)
    expect(
      loanSchema.safeParse({ ...rawLoan, recovery: { ...recovery, actorId: 'u-1' } }).success,
    ).toBe(true)
    expect(loanSchema.parse({ ...rawLoan, recovery }).recovery).not.toHaveProperty('actorId')
  })
})

describe('createLoanRequestSchema', () => {
  it('вимагає лише примірник — решта опційна', () => {
    expect(createLoanRequestSchema.parse({ copyId: 'copy-1' })).toEqual({ copyId: 'copy-1' })
  })

  it('позичається Copy, а не Work чи Edition (§3)', () => {
    // Ключова вимога домену: жодного `workId` чи `editionId` тут бути не може —
    // у різних примірників різні стани, різні лоани й різна історія.
    expect(createLoanRequestSchema.safeParse({ workId: 'work-1' }).success).toBe(false)
    expect(createLoanRequestSchema.safeParse({ editionId: 'edition-1' }).success).toBe(false)
  })

  it('бажаний термін — це дата, а не мить', () => {
    expect(
      createLoanRequestSchema.parse({ copyId: 'c-1', proposedDueAt: '2026-06-12' }).proposedDueAt,
    ).toBe('2026-06-12')
    expect(
      createLoanRequestSchema.safeParse({ copyId: 'c-1', proposedDueAt: '2026-06-12T10:00Z' })
        .success,
    ).toBe(false)
  })
})

describe('updateLoanRequestSchema', () => {
  it.each([...LOAN_ACTIONS].filter((action) => action !== 'amend_record'))(
    'приймає дію %s',
    (action) => {
      expect(updateLoanRequestSchema.parse({ action }).action).toBe(action)
    },
  )

  it('не приймає статус замість дії', () => {
    // §8 адресує ДІЮ, а не цільовий статус: інакше клієнт вирішував би, куди
    // веде перехід, і стейт-машина розповзлася б за мережу.
    for (const status of LOAN_STATUS) {
      expect(updateLoanRequestSchema.safeParse({ action: status }).success).toBe(false)
    }
  })

  it('дата знахідки дозволена лише разом із recover, і без note (CT1)', () => {
    expect(
      updateLoanRequestSchema.parse({ action: 'recover', effectiveAt: '2026-09-20' }).effectiveAt,
    ).toBe('2026-09-20')
    expect(updateLoanRequestSchema.safeParse({ action: 'recover' }).success).toBe(true)

    for (const action of LOAN_ACTIONS.filter((value) => value !== 'recover')) {
      expect(updateLoanRequestSchema.safeParse({ action, effectiveAt: '2026-09-20' }).success).toBe(
        false,
      )
    }

    for (const effectiveAt of ['2026-09-20T10:00:00Z', '2026-02-30', 'вчора']) {
      expect(updateLoanRequestSchema.safeParse({ action: 'recover', effectiveAt }).success).toBe(
        false,
      )
    }

    expect(updateLoanRequestSchema.safeParse({ action: 'recover', note: 'знайшли' }).success).toBe(
      false,
    )
  })

  it('термін повернення дозволений лише разом із approve або amend_record', () => {
    for (const action of ['approve', 'amend_record'] as const) {
      expect(updateLoanRequestSchema.safeParse({ action, dueAt: '2026-06-12' }).success).toBe(true)
    }

    for (const action of LOAN_ACTIONS.filter(
      (value) => value !== 'approve' && value !== 'amend_record',
    )) {
      expect(updateLoanRequestSchema.safeParse({ action, dueAt: '2026-06-12' }).success).toBe(false)
    }
  })

  it('без терміну будь-яка дія request-flow, крім recover, приймає примітку; дії запису — ні (10e)', () => {
    for (const action of LOAN_ACTIONS.filter(
      (value) => value !== 'recover' && !isRecordAction(value),
    )) {
      expect(updateLoanRequestSchema.safeParse({ action, note: 'бо так' }).success).toBe(true)
    }
  })
})

describe('Stage 10 (10e): дії запису наявної позики', () => {
  it('isRecordAction впізнає рівно чотири дії', () => {
    expect(LOAN_ACTIONS.filter((action) => isRecordAction(action)).sort()).toEqual([
      'amend_record',
      'confirm_record',
      'decline_record',
      'withdraw_record',
    ])
  })

  it('дата передачі — лише з amend_record; amend_record потребує хоча б однієї дати', () => {
    expect(
      updateLoanRequestSchema.safeParse({ action: 'amend_record', handedAt: '2026-05-01' }).success,
    ).toBe(true)
    expect(updateLoanRequestSchema.safeParse({ action: 'amend_record' }).success).toBe(false)

    for (const action of LOAN_ACTIONS.filter((value) => value !== 'amend_record')) {
      expect(updateLoanRequestSchema.safeParse({ action, handedAt: '2026-05-01' }).success).toBe(
        false,
      )
    }
  })

  it('Q23: dueAt у amend_record — відсутнє / null / дата / невалідне; null лише для amend_record', () => {
    const amend = (extra: Record<string, unknown>) =>
      updateLoanRequestSchema.safeParse({ action: 'amend_record', ...extra })

    expect(amend({ dueAt: null }).success).toBe(true)
    expect(amend({ dueAt: '2026-10-01' }).success).toBe(true)
    expect(amend({ handedAt: '2026-05-01' }).success).toBe(true)
    expect(amend({ dueAt: 'колись' }).success).toBe(false)
    expect(amend({ dueAt: '' }).success).toBe(false)
    expect(amend({}).success).toBe(false)
    expect(amend({ dueAt: null }).data).toHaveProperty('dueAt', null)
    expect(amend({ handedAt: '2026-05-01' }).data).not.toHaveProperty('dueAt')

    for (const action of LOAN_ACTIONS.filter((value) => value !== 'amend_record')) {
      expect(updateLoanRequestSchema.safeParse({ action, dueAt: null }).success).toBe(false)
    }
  })

  it('note із діями запису відхиляється', () => {
    for (const action of ['confirm_record', 'decline_record', 'withdraw_record'] as const) {
      expect(updateLoanRequestSchema.safeParse({ action }).success).toBe(true)
      expect(updateLoanRequestSchema.safeParse({ action, note: 'x' }).success).toBe(false)
    }
  })

  it('createRecordedLoanRequestSchema: обов’язкові copyId, borrowerId, handedAt; dueAt не раніше передачі', () => {
    const base = { copyId: 'c-1', borrowerId: 'u-1', handedAt: '2026-05-01' }

    expect(createRecordedLoanRequestSchema.safeParse(base).success).toBe(true)
    expect(
      createRecordedLoanRequestSchema.safeParse({ ...base, dueAt: '2026-05-01' }).success,
    ).toBe(true)
    expect(
      createRecordedLoanRequestSchema.safeParse({ ...base, dueAt: '2026-04-30' }).success,
    ).toBe(false)
    expect(createRecordedLoanRequestSchema.safeParse({ ...base, handedAt: 'вчора' }).success).toBe(
      false,
    )

    for (const key of ['copyId', 'borrowerId', 'handedAt'] as const) {
      const { [key]: _omitted, ...rest } = base

      expect(createRecordedLoanRequestSchema.safeParse(rest).success).toBe(false)
    }
  })

  it('loanSchema: requestedAt = null для записаної позики; origin RECORDED_GUEST не віддається', () => {
    expect(
      loanSchema.safeParse({ ...rawLoan, origin: 'RECORDED_EXISTING', requestedAt: null }).success,
    ).toBe(true)
    expect(loanSchema.safeParse({ ...rawLoan, origin: 'RECORDED_GUEST' }).success).toBe(false)
  })
})

describe('loanQueryRequestSchema', () => {
  it('усі фільтри опційні', () => {
    expect(loanQueryRequestSchema.parse({})).toEqual({})
  })

  it.each(['owner', 'borrower'])('фільтрує за role=%s', (role) => {
    expect(loanQueryRequestSchema.parse({ role }).role).toBe(role)
  })

  it('відхиляє неіснуючу роль', () => {
    expect(loanQueryRequestSchema.safeParse({ role: 'admin' }).success).toBe(false)
  })
})
