import { GUEST_CONFIRMATION_ACTIONS, GUEST_LOAN_CONFIRMATION_STATUS } from '@bookswap/shared'
import { resolveConfirmationTransition } from './guest-loan-confirmation.transitions'

describe('resolveConfirmationTransition (Stage 10, 10i.1)', () => {
  it.each(['OPEN', 'DENIED'] as const)(
    '%s → cancel_handover: CANCELLED / AVAILABLE, без відхилення REQUESTED',
    (from) => {
      expect(resolveConfirmationTransition(from, 'cancel_handover')).toEqual({
        confirmationTo: 'CANCELLED',
        loanTo: 'CANCELLED',
        copyTo: 'AVAILABLE',
        event: 'GUEST_HANDOVER_CANCELLED',
        rejectsRequestedRivals: false,
      })
    },
  )

  it.each(['OPEN', 'DENIED'] as const)(
    '%s → record_owner_statement: OWNER_RECORDED / HANDED_OVER / LENT_OUT, відхиляє REQUESTED',
    (from) => {
      expect(resolveConfirmationTransition(from, 'record_owner_statement')).toEqual({
        confirmationTo: 'OWNER_RECORDED',
        loanTo: 'HANDED_OVER',
        copyTo: 'LENT_OUT',
        event: 'GUEST_LOAN_OWNER_RECORDED',
        rejectsRequestedRivals: true,
      })
    },
  )

  it.each(['RECEIVED', 'CANCELLED', 'OWNER_RECORDED'] as const)(
    'термінальний стан %s: жодна дія неможлива',
    (from) => {
      for (const action of GUEST_CONFIRMATION_ACTIONS) {
        expect(resolveConfirmationTransition(from, action)).toBeNull()
      }
    },
  )

  it('повна матриця: дозволені рівно 2 стани × 2 дії', () => {
    let allowed = 0

    for (const from of GUEST_LOAN_CONFIRMATION_STATUS) {
      for (const action of GUEST_CONFIRMATION_ACTIONS) {
        if (resolveConfirmationTransition(from, action) !== null) allowed += 1
      }
    }

    expect(allowed).toBe(4)
  })

  it('заперечення гостя саме по собі Copy не звільняє: AVAILABLE лише через cancel_handover', () => {
    const availableTransitions = GUEST_LOAN_CONFIRMATION_STATUS.flatMap((from) =>
      GUEST_CONFIRMATION_ACTIONS.map((action) => resolveConfirmationTransition(from, action)),
    ).filter((transition) => transition?.copyTo === 'AVAILABLE')

    expect(
      availableTransitions.every((transition) => transition?.event === 'GUEST_HANDOVER_CANCELLED'),
    ).toBe(true)
  })
})
