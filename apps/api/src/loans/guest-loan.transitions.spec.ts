import { GUEST_LOAN_ACTIONS, type GuestLoanAction } from '@bookswap/shared'
import {
  resolveGuestTransition,
  type GuestLoanStatus,
  type GuestLoanTransition,
} from './loan.transitions'

/**
 * Stage 10 (10f.3, §6.2 execution plan): вичерпна перевірка таблиці переходів гостьової позики —
 * той самий підхід, що `loan.transitions.spec.ts` для реєстрованого флоу: чиста функція, тож
 * перебір усіх комбінацій статус×дія дешевий і повний.
 */

const GUEST_STATUSES: GuestLoanStatus[] = ['HANDED_OVER', 'RETURNED', 'LOST']

interface AllowedRow {
  from: GuestLoanStatus
  action: GuestLoanAction
  expected: GuestLoanTransition
}

const ALLOWED: AllowedRow[] = [
  {
    from: 'HANDED_OVER',
    action: 'return',
    expected: {
      to: 'RETURNED',
      requiresCopyStatus: 'LENT_OUT',
      copyStatus: 'AVAILABLE',
      copyHolder: 'OWNER',
      stamp: 'returnedAt',
      event: 'LOAN_RETURNED',
    },
  },
  {
    from: 'HANDED_OVER',
    action: 'mark_lost',
    expected: {
      to: 'LOST',
      requiresCopyStatus: 'LENT_OUT',
      copyStatus: 'UNAVAILABLE',
      copyHolder: null,
      stamp: null,
      event: 'LOAN_LOST',
    },
  },
  {
    from: 'LOST',
    action: 'recover',
    expected: {
      to: 'LOST',
      requiresCopyStatus: 'UNAVAILABLE',
      copyStatus: 'AVAILABLE',
      copyHolder: 'OWNER',
      stamp: null,
      event: 'RECOVERED',
    },
  },
  {
    from: 'LOST',
    action: 'close_loss',
    expected: {
      to: 'LOST',
      requiresCopyStatus: null,
      copyStatus: null,
      copyHolder: null,
      stamp: null,
      event: 'LOSS_CLOSED',
    },
  },
]

function isAllowed(from: GuestLoanStatus, action: GuestLoanAction): AllowedRow | undefined {
  return ALLOWED.find((row) => row.from === from && row.action === action)
}

describe('resolveGuestTransition (Stage 10, 10f.3)', () => {
  it('дозволяє рівно ті переходи, що в §6.2 execution plan, з точними полями', () => {
    for (const row of ALLOWED) {
      expect(resolveGuestTransition(row.from, row.action)).toEqual(row.expected)
    }
  })

  it('усе, чого немає в таблиці — відмова, без винятку', () => {
    for (const from of GUEST_STATUSES) {
      for (const action of GUEST_LOAN_ACTIONS) {
        if (isAllowed(from, action) !== undefined) continue

        expect(resolveGuestTransition(from, action)).toEqual({ kind: 'refused' })
      }
    }
  })

  it('RETURNED — термінальний: жодна дія не веде далі', () => {
    for (const action of GUEST_LOAN_ACTIONS) {
      expect(resolveGuestTransition('RETURNED', action)).toEqual({ kind: 'refused' })
    }
  })

  it('close_loss не змінює жодного поля Copy/Loan.status (T7b, §0.7.1)', () => {
    const outcome = resolveGuestTransition('LOST', 'close_loss')

    if ('kind' in outcome) throw new Error('close_loss мав бути дозволений із LOST')

    expect(outcome.to).toBe('LOST')
    expect(outcome.copyStatus).toBeNull()
    expect(outcome.copyHolder).toBeNull()
    expect(outcome.requiresCopyStatus).toBeNull()
  })

  it('recover не змінює Loan.status (лишається LOST) — лише Copy й подія', () => {
    const outcome = resolveGuestTransition('LOST', 'recover')

    if ('kind' in outcome) throw new Error('recover мав бути дозволений із LOST')

    expect(outcome.to).toBe('LOST')
    expect(outcome.stamp).toBeNull()
  })
})
