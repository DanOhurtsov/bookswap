import { LOAN_ACTIONS, LOAN_STATUS, type LoanRole } from '@bookswap/shared'
import { ACTION_DONE_MESSAGES, actionPlanOf, type PlannedAction } from './loan-action-plan'

const actionsOf = (plan: ReturnType<typeof actionPlanOf>) =>
  plan.kind === 'buttons'
    ? {
        buttons: plan.buttons.map(({ action }) => action),
        menu: plan.menu.map(({ action }) => action),
      }
    : plan.kind

describe('дії на сторінці позики за таблицею §5.1', () => {
  it.each<[string, LoanRole, unknown]>([
    ['REQUESTED', 'owner', 'answer'],
    ['REQUESTED', 'borrower', { buttons: ['cancel'], menu: [] }],
    ['APPROVED', 'owner', { buttons: ['cancel'], menu: [] }],
    ['APPROVED', 'borrower', { buttons: ['hand_over', 'cancel'], menu: [] }],
    ['HANDED_OVER', 'owner', { buttons: ['return'], menu: ['mark_lost'] }],
    ['HANDED_OVER', 'borrower', 'none'],
    ['LOST', 'owner', 'recover'],
    ['LOST', 'borrower', 'recover'],
    ['PENDING_CONFIRMATION', 'owner', 'record'],
    ['PENDING_CONFIRMATION', 'borrower', 'record'],
  ])('%s, %s → %j', (status, role, expected) => {
    const known = LOAN_STATUS.find((value) => value === status)

    expect(known).toBeDefined()
    if (known !== undefined) expect(actionsOf(actionPlanOf(known, role))).toEqual(expected)
  })

  it('отримання підтверджує лише позичальник: власник не має альтернативної «передачі»', () => {
    for (const status of LOAN_STATUS) {
      const plan = actionPlanOf(status, 'owner')
      const offered = plan.kind === 'buttons' ? [...plan.buttons, ...plan.menu] : []

      expect(offered.map(({ action }) => action)).not.toContain('hand_over')
    }
  })

  it.each(['REJECTED', 'CANCELLED', 'RETURNED', 'DECLINED'] as const)(
    '%s — кінцевий стан: жодних дій для обох сторін',
    (status) => {
      expect(actionPlanOf(status, 'owner')).toEqual({ kind: 'none' })
      expect(actionPlanOf(status, 'borrower')).toEqual({ kind: 'none' })
    },
  )

  const offeredBy = (status: (typeof LOAN_STATUS)[number], role: LoanRole): PlannedAction[] => {
    const plan = actionPlanOf(status, role)

    return plan.kind === 'buttons' ? [...plan.buttons, ...plan.menu] : []
  }
  const everyOffered = () =>
    LOAN_STATUS.flatMap((status) =>
      (['owner', 'borrower'] as const).flatMap((role) => offeredBy(status, role)),
    )

  it('незворотні дії — скасування й втрата — питають підтвердження з поясненням', () => {
    const confirmed = everyOffered().filter(({ confirm }) => confirm !== null)

    expect(new Set(confirmed.map(({ action }) => action))).toEqual(new Set(['cancel', 'mark_lost']))
    for (const { confirm } of confirmed) expect(confirm?.description).toBeTruthy()
  })

  it('скасування називає, що скасовує: запит до відповіді, позику після погодження', () => {
    expect(offeredBy('REQUESTED', 'borrower')).toEqual([
      expect.objectContaining({ action: 'cancel', label: 'Скасувати запит' }),
    ])
    expect(offeredBy('APPROVED', 'owner')).toEqual([
      expect.objectContaining({ action: 'cancel', label: 'Скасувати позику' }),
    ])
  })

  it('діалог скасування закривається словами «Не скасовувати», діалог втрати — «Назад»', () => {
    const dismissOf = (status: (typeof LOAN_STATUS)[number], role: LoanRole) =>
      offeredBy(status, role).flatMap(({ action, confirm }) =>
        confirm === null ? [] : [[action, confirm.dismissLabel]],
      )

    expect(dismissOf('REQUESTED', 'borrower')).toEqual([['cancel', 'Не скасовувати']])
    expect(dismissOf('APPROVED', 'borrower')).toEqual([['cancel', 'Не скасовувати']])
    expect(dismissOf('HANDED_OVER', 'owner')).toEqual([['mark_lost', 'Назад']])
  })

  it('кожна дія має текст про результат, без обіцянок майбутнього', () => {
    for (const action of LOAN_ACTIONS) {
      expect(ACTION_DONE_MESSAGES[action]).toBeTruthy()
      expect(ACTION_DONE_MESSAGES[action]).not.toMatch(/нагада|продовж|сповіст|повідом/iu)
    }
  })
})
