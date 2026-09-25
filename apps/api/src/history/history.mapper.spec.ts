import {
  byRequestedAt,
  toAnonymousEntry,
  toHistoryEntry,
  toNamedEntry,
  type HistoryLoanRow,
  type NamedHistoryLoanRow,
} from './history.mapper'

/**
 * §6.6 у частині «що саме віддається назовні».
 *
 * Ключова вимога §9: приватне не повертається з API, а не ховається в UI. Тому
 * нижче перевіряється **відсутність** ключів, а не їхнє значення: `borrower: null`
 * теж був би витоком — він каже, що позичальник узагалі був.
 */

const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: null }

const NOW = new Date('2026-06-15T12:00:00.000Z')

function loanRow(overrides: Partial<NamedHistoryLoanRow> = {}): NamedHistoryLoanRow {
  return {
    id: 'loan-1',
    status: 'RETURNED',
    origin: 'REQUESTED',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    requestedAt: new Date('2026-06-01T10:00:00.000Z'),
    respondedAt: new Date('2026-06-02T10:00:00.000Z'),
    handedAt: new Date('2026-06-03T10:00:00.000Z'),
    returnedAt: new Date('2026-06-10T10:00:00.000Z'),
    dueAt: new Date('2026-06-12T23:59:59.999Z'),
    owner: MARTA,
    borrower: OLES,
    ...overrides,
  }
}

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
  'displayName',
  'avatarUrl',
  'email',
]

describe('toNamedEntry', () => {
  it('віддає обидві сторони — §6.6 для власника й для друга з дозволом', () => {
    const entry = toNamedEntry(loanRow(), NOW)

    expect(entry.names).toBe(true)
    expect(entry.owner).toEqual(MARTA)
    expect(entry.borrower).toEqual(OLES)
    expect(entry.loanId).toBe('loan-1')
  })

  it('несе факти: статуси й дати', () => {
    const entry = toNamedEntry(loanRow(), NOW)

    expect(entry.status).toBe('RETURNED')
    expect(entry.requestedAt).toBe('2026-06-01T10:00:00.000Z')
    expect(entry.returnedAt).toBe('2026-06-10T10:00:00.000Z')
    // Термін — днем, як і всюди: «до 12 червня», а не мить із мілісекундами.
    expect(entry.dueAt).toBe('2026-06-12')
  })
})

describe('toAnonymousEntry', () => {
  it('не має ЖОДНОГО поля, яким можна відновити особу (§6.6)', () => {
    const entry = toAnonymousEntry(loanRow(), NOW)

    for (const key of IDENTIFYING_KEYS) {
      expect(entry).not.toHaveProperty(key)
    }
  })

  it('не має loanId: за ним два зрізи анонімної історії склеїлися б в одну людину', () => {
    expect(toAnonymousEntry(loanRow(), NOW)).not.toHaveProperty('loanId')
  })

  it('у сирому JSON немає ані імен, ані ідентифікаторів учасників', () => {
    // Перевірка саме по рядку: вкладене поле, яке забули прибрати, у
    // `toHaveProperty` на верхньому рівні не видно.
    const raw = JSON.stringify(toAnonymousEntry(loanRow(), NOW))

    expect(raw).not.toContain('Марта')
    expect(raw).not.toContain('Олесь')
    expect(raw).not.toContain('user-marta')
    expect(raw).not.toContain('user-oles')
    expect(raw).not.toContain('loan-1')
  })

  it('статус і дати лишаються — «у когось до 12 червня»', () => {
    const entry = toAnonymousEntry(loanRow({ status: 'HANDED_OVER' }), NOW)

    expect(entry.names).toBe(false)
    expect(entry.status).toBe('HANDED_OVER')
    expect(entry.dueAt).toBe('2026-06-12')
  })

  it('прострочення видно й без імен: це факт про книжку, а не про людину', () => {
    const overdue = loanRow({
      status: 'HANDED_OVER',
      returnedAt: null,
      dueAt: new Date('2026-06-01T23:59:59.999Z'),
    })

    expect(toAnonymousEntry(overdue, NOW).isOverdue).toBe(true)
  })
})

describe('toHistoryEntry', () => {
  it('прапорець вирішує, яка саме проєкція піде назовні', () => {
    // Сам прапорець рахує `holderNamesVisibleTo` зі §9 — мапер його не виводить,
    // інакше правило видимості імен існувало б у двох місцях.
    expect(toHistoryEntry(loanRow(), true, NOW).names).toBe(true)
    expect(toHistoryEntry(loanRow(), false, NOW).names).toBe(false)
  })

  it('обидві проєкції описують той самий лоан однаково в частині фактів', () => {
    const named = toHistoryEntry(loanRow(), true, NOW)
    const anonymous = toHistoryEntry(loanRow(), false, NOW)

    expect(anonymous.status).toBe(named.status)
    expect(anonymous.requestedAt).toBe(named.requestedAt)
    expect(anonymous.dueAt).toBe(named.dueAt)
  })
})

/**
 * Stage 10 (T1, D4): гостьова позика не має зареєстрованого позичальника. До кроку 10f
 * гостя не показує ніхто — навіть власник, — тож і `showNames = true` дає анонімний запис.
 */
describe('гостьова позика без зареєстрованого позичальника (Stage 10)', () => {
  const guestLoan: HistoryLoanRow = { ...loanRow(), borrower: null }

  it('showNames = true все одно дає анонімну проєкцію без ключів особи', () => {
    const entry = toHistoryEntry(guestLoan, true, NOW)

    expect(entry.names).toBe(false)

    for (const key of IDENTIFYING_KEYS) {
      expect(entry).not.toHaveProperty(key)
    }
  })

  it('зареєстрований позичальник і showNames = true — як і раніше іменована', () => {
    expect(toHistoryEntry(loanRow(), true, NOW).names).toBe(true)
  })
})

describe('записана власником позика без requestedAt (Stage 10, T2)', () => {
  it('requestedAt = null не вигадується і не ламає проєкцію', () => {
    const entry = toHistoryEntry(loanRow({ requestedAt: null }), false, NOW)

    expect(entry.requestedAt).toBeNull()
  })

  it('byRequestedAt падає назад на createdAt, коли запиту не було', () => {
    const early = loanRow({
      id: 'a',
      requestedAt: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    })
    const late = loanRow({ id: 'b', requestedAt: new Date('2026-06-01T00:00:00Z') })

    expect(byRequestedAt(early, late)).toBeLessThan(0)
  })
})
