import { LOAN_ACTIONS, LOAN_STATUS, type LoanAction, type LoanStatus } from '@bookswap/shared'
import { resolveTransition, type LoanActor, type LoanTransition } from './loan.transitions'
import type { LoanOrigin } from '@bookswap/shared'

/**
 * Таблиця §5.1 повністю — позитивні переходи, негативні й неправильні актори.
 *
 * Без PostgreSQL і без Nest: рішення про перехід ухвалює чиста функція, і саме
 * тому найкритичнішу частину логіки можна перебрати вичерпно, а не вибірково.
 */

const OWNER: LoanActor = 'OWNER'
const BORROWER: LoanActor = 'BORROWER'

/** Рядок таблиці §5.1: звідки, що, хто. */
interface Row {
  from: LoanStatus
  action: LoanAction
  actor: LoanActor
}

const ALLOWED: Row[] = [
  { from: 'REQUESTED', action: 'approve', actor: OWNER },
  { from: 'REQUESTED', action: 'reject', actor: OWNER },
  { from: 'REQUESTED', action: 'cancel', actor: BORROWER },
  { from: 'APPROVED', action: 'cancel', actor: OWNER },
  { from: 'APPROVED', action: 'cancel', actor: BORROWER },
  { from: 'APPROVED', action: 'hand_over', actor: BORROWER },
  { from: 'HANDED_OVER', action: 'return', actor: OWNER },
  { from: 'HANDED_OVER', action: 'mark_lost', actor: OWNER },
  // Stage 10 (10d): `LOST → LOST` + подія; єдиний вихід зі «термінального» LOST.
  { from: 'LOST', action: 'recover', actor: OWNER },
]

function isAllowed(row: Row): boolean {
  return ALLOWED.some(
    (allowed) =>
      allowed.from === row.from && allowed.action === row.action && allowed.actor === row.actor,
  )
}

/** Звужує результат до переходу — інакше кожна перевірка починалася б із `if`. */
function transition(from: LoanStatus, action: LoanAction, actor: LoanActor): LoanTransition {
  const outcome = resolveTransition(from, action, actor, 'REQUESTED')

  if ('kind' in outcome) {
    throw new Error(`Очікувався перехід ${from} --${action}--> для ${actor}, отримано відмову`)
  }

  return outcome
}

describe('resolveTransition: вичерпна матриця', () => {
  const combinations = LOAN_STATUS.flatMap((from) =>
    LOAN_ACTIONS.flatMap((action) =>
      [OWNER, BORROWER].map((actor): Row => ({ from, action, actor })),
    ),
  )

  it('перебирає всі 9 × 11 × 2 комбінацій — жодна не лишається невизначеною', () => {
    expect(combinations).toHaveLength(198)
  })

  it.each(combinations)('$from --$action--> для $actor', ({ from, action, actor }: Row) => {
    const outcome = resolveTransition(from, action, actor, 'REQUESTED')

    // Дозволено рівно те, що перелічує §5.1, і нічого більше. Саме ця
    // перевірка ловить випадково розширений перехід: додати рядок у машину, не
    // додавши його в ALLOWED, неможливо непомітно.
    expect('kind' in outcome).toBe(!isAllowed({ from, action, actor }))
  })
})

describe('термінальні статуси §5.1', () => {
  // Stage 10: `PENDING_CONFIRMATION`/`DECLINED` до кроку 10e так само не мають жодного request-flow переходу.
  const terminal: LoanStatus[] = [
    'REJECTED',
    'CANCELLED',
    'RETURNED',
    'PENDING_CONFIRMATION',
    'DECLINED',
  ]

  it.each(terminal)('з %s не веде жоден перехід — ні для кого', (from) => {
    for (const action of LOAN_ACTIONS) {
      for (const actor of [OWNER, BORROWER]) {
        expect(resolveTransition(from, action, actor, 'REQUESTED')).toEqual({
          kind: 'refused',
          reason: 'STATE',
        })
      }
    }
  })
})

describe('LOST (Stage 10, 10d): лише recover, лише власник', () => {
  it('усі дії request-flow з LOST — STATE', () => {
    for (const action of LOAN_ACTIONS.filter((value) => value !== 'recover')) {
      for (const actor of [OWNER, BORROWER]) {
        expect(resolveTransition('LOST', action, actor, 'REQUESTED')).toEqual({
          kind: 'refused',
          reason: 'STATE',
        })
      }
    }
  })

  it('recover позичальника — ROLE, не STATE', () => {
    expect(resolveTransition('LOST', 'recover', BORROWER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
  })

  it('recover не змінює статус і не ставить жодної позначки часу', () => {
    const outcome = transition('LOST', 'recover', OWNER)

    expect(outcome.to).toBe('LOST')
    expect(outcome.stamp).toBeNull()
    expect(outcome.notify).toBeNull()
    expect(outcome.rejectRivals).toBe(false)
    expect(outcome.event).toBe('RECOVERED')
  })

  it('recover повертає книжку власнику: AVAILABLE, тримач — власник; вимагає UNAVAILABLE у позичальника', () => {
    const outcome = transition('LOST', 'recover', OWNER)

    expect(outcome.copyStatus).toBe('AVAILABLE')
    expect(outcome.holder).toBe('OWNER')
    expect(outcome.requires).toEqual({ status: 'UNAVAILABLE', holder: 'BORROWER' })
  })

  it('recover з інших статусів неможливий ні для кого', () => {
    for (const from of LOAN_STATUS.filter((value) => value !== 'LOST')) {
      for (const actor of [OWNER, BORROWER]) {
        expect(resolveTransition(from, 'recover', actor, 'REQUESTED')).toEqual({
          kind: 'refused',
          reason: 'STATE',
        })
      }
    }
  })

  it('LOAN_LOST пишеться лише при mark_lost; решта переходів подій не пишуть', () => {
    expect(transition('HANDED_OVER', 'mark_lost', OWNER).event).toBe('LOAN_LOST')

    for (const row of ALLOWED.filter((r) => r.action !== 'mark_lost' && r.action !== 'recover')) {
      expect(transition(row.from, row.action, row.actor).event).toBeNull()
    }
  })
})

describe('розрізнення відмов', () => {
  it('дія, неможлива з цього статусу, — це STATE, а не ROLE', () => {
    // Повернути ще не передану книжку не може ніхто, тож «вам не можна» (403)
    // сказало б неправду: справа не в тому, хто питає.
    expect(resolveTransition('REQUESTED', 'return', OWNER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'STATE',
    })
  })

  it('дія, можлива для іншої сторони, — це ROLE', () => {
    expect(resolveTransition('REQUESTED', 'approve', BORROWER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
    expect(resolveTransition('APPROVED', 'hand_over', OWNER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
    expect(resolveTransition('HANDED_OVER', 'return', BORROWER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
    expect(resolveTransition('HANDED_OVER', 'mark_lost', BORROWER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
  })

  it('скасувати власний запит може лише позичальник', () => {
    expect(resolveTransition('REQUESTED', 'cancel', OWNER, 'REQUESTED')).toEqual({
      kind: 'refused',
      reason: 'ROLE',
    })
  })

  it('розірвати домовленість може будь-яка зі сторін (§5.1)', () => {
    expect(transition('APPROVED', 'cancel', OWNER).to).toBe('CANCELLED')
    expect(transition('APPROVED', 'cancel', BORROWER).to).toBe('CANCELLED')
  })
})

describe('timestamps §5.1', () => {
  it('respondedAt ставить лише відповідь власника на запит', () => {
    expect(transition('REQUESTED', 'approve', OWNER).stamp).toBe('respondedAt')
    expect(transition('REQUESTED', 'reject', OWNER).stamp).toBe('respondedAt')
  })

  it('скасування не ставить respondedAt: відповіді не було', () => {
    // Позичальник забрав запит — власник на нього так і не відповів. Позначка
    // стверджувала б, що відповідь була, і історія почала б брехати.
    expect(transition('REQUESTED', 'cancel', BORROWER).stamp).toBeNull()
  })

  it('скасування домовленості не перезаписує respondedAt від апруву', () => {
    // Поле відповідає на «коли власник відповів на запит», а не «коли востаннє
    // щось сталося». Апрув уже його поставив.
    expect(transition('APPROVED', 'cancel', OWNER).stamp).toBeNull()
    expect(transition('APPROVED', 'cancel', BORROWER).stamp).toBeNull()
  })

  it('handedAt — лише передача, returnedAt — лише повернення', () => {
    expect(transition('APPROVED', 'hand_over', BORROWER).stamp).toBe('handedAt')
    expect(transition('HANDED_OVER', 'return', OWNER).stamp).toBe('returnedAt')
  })

  it('списання не має власної позначки: колонки під неї в §4.6 немає', () => {
    expect(transition('HANDED_OVER', 'mark_lost', OWNER).stamp).toBeNull()
  })
})

describe('побічні зміни Copy §5.1', () => {
  it('APPROVED резервує книжку, але НЕ передає володіння (§5.2)', () => {
    const outcome = transition('REQUESTED', 'approve', OWNER)

    expect(outcome.copyStatus).toBe('RESERVED')
    // Найважливіший рядок цього файлу: підтвердження ≠ передача. Поки
    // позичальник не натиснув «отримав», книжка формально вдома.
    expect(outcome.holder).toBeNull()
  })

  it('тільки HANDED_OVER передає фізичне володіння', () => {
    const outcome = transition('APPROVED', 'hand_over', BORROWER)

    expect(outcome.copyStatus).toBe('LENT_OUT')
    expect(outcome.holder).toBe('BORROWER')
  })

  it('RETURNED повертає і статус, і володіння власнику', () => {
    const outcome = transition('HANDED_OVER', 'return', OWNER)

    expect(outcome.copyStatus).toBe('AVAILABLE')
    expect(outcome.holder).toBe('OWNER')
  })

  it('LOST лишає тримача на позичальнику — книжка фізично в нього', () => {
    const outcome = transition('HANDED_OVER', 'mark_lost', OWNER)

    expect(outcome.copyStatus).toBe('UNAVAILABLE')
    expect(outcome.holder).toBeNull()
  })

  it('скасування домовленості звільняє примірник', () => {
    expect(transition('APPROVED', 'cancel', OWNER).copyStatus).toBe('AVAILABLE')
  })

  it('відмова та скасування запиту примірника не чіпають', () => {
    // Власник міг тим часом перемкнути книжку в UNAVAILABLE; «прибрати запит» не
    // має права мовчки скасувати це рішення.
    expect(transition('REQUESTED', 'reject', OWNER).copyStatus).toBeNull()
    expect(transition('REQUESTED', 'reject', OWNER).holder).toBeNull()
    expect(transition('REQUESTED', 'cancel', BORROWER).copyStatus).toBeNull()
    expect(transition('REQUESTED', 'cancel', BORROWER).holder).toBeNull()
  })
})

describe('передумови на стан примірника', () => {
  it('апрув вимагає вільну книжку вдома', () => {
    expect(transition('REQUESTED', 'approve', OWNER).requires).toEqual({
      status: 'AVAILABLE',
      holder: 'OWNER',
    })
  })

  it('передача та скасування домовленості вимагають RESERVED вдома', () => {
    expect(transition('APPROVED', 'hand_over', BORROWER).requires).toEqual({
      status: 'RESERVED',
      holder: 'OWNER',
    })
    expect(transition('APPROVED', 'cancel', OWNER).requires).toEqual({
      status: 'RESERVED',
      holder: 'OWNER',
    })
  })

  it('повернення та списання вимагають LENT_OUT у позичальника', () => {
    expect(transition('HANDED_OVER', 'return', OWNER).requires).toEqual({
      status: 'LENT_OUT',
      holder: 'BORROWER',
    })
    expect(transition('HANDED_OVER', 'mark_lost', OWNER).requires).toEqual({
      status: 'LENT_OUT',
      holder: 'BORROWER',
    })
  })

  it('прибрати висячий запит можна за будь-якого стану примірника', () => {
    // Саме тут `requires: null` значуще: власник, який перемкнув книжку в
    // UNAVAILABLE, інакше не зміг би відмовити тому, хто вже попросив.
    expect(transition('REQUESTED', 'reject', OWNER).requires).toBeNull()
    expect(transition('REQUESTED', 'cancel', BORROWER).requires).toBeNull()
  })
})

describe('сповіщення §5.1 і §7.5', () => {
  it('апрув сповіщає позичальника й відхиляє конкурентів', () => {
    const outcome = transition('REQUESTED', 'approve', OWNER)

    expect(outcome.notify).toEqual({ to: 'BORROWER', type: 'LOAN_APPROVED' })
    expect(outcome.rejectRivals).toBe(true)
  })

  it('авто-відхилення конкурентів буває ЛИШЕ на апруві', () => {
    for (const row of ALLOWED) {
      if (row.from === 'REQUESTED' && row.action === 'approve') continue

      expect(transition(row.from, row.action, row.actor).rejectRivals).toBe(false)
    }
  })

  it('скасування домовленості сповіщає другу сторону, хто б її не почав', () => {
    expect(transition('APPROVED', 'cancel', OWNER).notify).toEqual({
      to: 'COUNTERPARTY',
      type: 'LOAN_CANCELLED',
    })
    expect(transition('APPROVED', 'cancel', BORROWER).notify).toEqual({
      to: 'COUNTERPARTY',
      type: 'LOAN_CANCELLED',
    })
  })

  it('скасування запиту й списання сповіщень не породжують', () => {
    // §5.1 у цих рядках має порожню клітинку побічних ефектів, і §7.5 їх не
    // перелічує. «Він передумав» — повідомлення, яке нікому не допомагає.
    expect(transition('REQUESTED', 'cancel', BORROWER).notify).toBeNull()
    expect(transition('HANDED_OVER', 'mark_lost', OWNER).notify).toBeNull()
  })

  it('LOAN_CANCELLED не використовується для скасування запиту', () => {
    expect(transition('REQUESTED', 'cancel', BORROWER).notify?.type).not.toBe('LOAN_CANCELLED')
  })

  it('решта переходів сповіщає ту сторону, яка не діяла', () => {
    expect(transition('REQUESTED', 'reject', OWNER).notify).toEqual({
      to: 'BORROWER',
      type: 'LOAN_REJECTED',
    })
    expect(transition('APPROVED', 'hand_over', BORROWER).notify).toEqual({
      to: 'OWNER',
      type: 'LOAN_HANDED_OVER',
    })
    expect(transition('HANDED_OVER', 'return', OWNER).notify).toEqual({
      to: 'BORROWER',
      type: 'LOAN_RETURNED',
    })
  })
})

/**
 * Stage 10 (10e, T3, D6): таблиця переходів записаної власником позики (`RECORDED_EXISTING`) — так само
 * вичерпно, з `origin`-відмовами в обидва боки.
 */
describe('resolveTransition: RECORDED_EXISTING (Stage 10, 10e)', () => {
  const ALLOWED_RECORDED: Row[] = [
    { from: 'PENDING_CONFIRMATION', action: 'confirm_record', actor: BORROWER },
    { from: 'PENDING_CONFIRMATION', action: 'decline_record', actor: BORROWER },
    { from: 'PENDING_CONFIRMATION', action: 'withdraw_record', actor: OWNER },
    { from: 'PENDING_CONFIRMATION', action: 'amend_record', actor: OWNER },
    { from: 'HANDED_OVER', action: 'return', actor: OWNER },
    { from: 'HANDED_OVER', action: 'mark_lost', actor: OWNER },
    { from: 'LOST', action: 'recover', actor: OWNER },
  ]

  const combinations = LOAN_STATUS.flatMap((from) =>
    LOAN_ACTIONS.flatMap((action) =>
      [OWNER, BORROWER].map((actor): Row => ({ from, action, actor })),
    ),
  )

  it.each(combinations)('$from --$action--> для $actor', ({ from, action, actor }: Row) => {
    const allowed = ALLOWED_RECORDED.some(
      (row) => row.from === from && row.action === action && row.actor === actor,
    )

    expect('kind' in resolveTransition(from, action, actor, 'RECORDED_EXISTING')).toBe(!allowed)
  })

  it('confirm_record: HANDED_OVER, LENT_OUT у позичальника, handedAt не перезаписується, чужі REQUESTED відхиляються', () => {
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'confirm_record', BORROWER, 'RECORDED_EXISTING'),
    ).toEqual({
      to: 'HANDED_OVER',
      requires: { status: 'RESERVED', holder: 'OWNER' },
      copyStatus: 'LENT_OUT',
      holder: 'BORROWER',
      stamp: null,
      notify: { to: 'OWNER', type: 'LOAN_RECORD_CONFIRMED' },
      rejectRivals: true,
      event: 'RECORD_CONFIRMED',
    })
  })

  it.each([
    ['decline_record', BORROWER, 'DECLINED', 'LOAN_RECORD_DECLINED', 'OWNER', 'RECORD_DECLINED'],
    [
      'withdraw_record',
      OWNER,
      'CANCELLED',
      'LOAN_RECORD_WITHDRAWN',
      'BORROWER',
      'RECORD_WITHDRAWN',
    ],
  ] as const)(
    '%s повертає примірник AVAILABLE і не чіпає чужих REQUESTED',
    (action, actor, to, type, recipient, event) => {
      expect(resolveTransition('PENDING_CONFIRMATION', action, actor, 'RECORDED_EXISTING')).toEqual(
        {
          to,
          requires: { status: 'RESERVED', holder: 'OWNER' },
          copyStatus: 'AVAILABLE',
          holder: null,
          stamp: null,
          notify: { to: recipient, type },
          rejectRivals: false,
          event,
        },
      )
    },
  )

  it('amend_record: статус і примірник не змінюються, сповіщення позичальнику', () => {
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'amend_record', OWNER, 'RECORDED_EXISTING'),
    ).toEqual({
      to: 'PENDING_CONFIRMATION',
      requires: { status: 'RESERVED', holder: 'OWNER' },
      copyStatus: null,
      holder: null,
      stamp: null,
      notify: { to: 'BORROWER', type: 'LOAN_RECORD_AMENDED' },
      rejectRivals: false,
      event: 'RECORD_AMENDED',
    })
  })

  it('роль: власник не підтверджує й не відхиляє, позичальник не відкликає й не виправляє (ROLE)', () => {
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'confirm_record', OWNER, 'RECORDED_EXISTING'),
    ).toEqual({ kind: 'refused', reason: 'ROLE' })
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'decline_record', OWNER, 'RECORDED_EXISTING'),
    ).toEqual({ kind: 'refused', reason: 'ROLE' })
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'withdraw_record', BORROWER, 'RECORDED_EXISTING'),
    ).toEqual({ kind: 'refused', reason: 'ROLE' })
    expect(
      resolveTransition('PENDING_CONFIRMATION', 'amend_record', BORROWER, 'RECORDED_EXISTING'),
    ).toEqual({ kind: 'refused', reason: 'ROLE' })
  })

  it('після підтвердження amend/withdraw/decline неможливі (Q12), а return/mark_lost/recover — за чинними правилами', () => {
    for (const action of [
      'amend_record',
      'withdraw_record',
      'decline_record',
      'confirm_record',
    ] as const) {
      for (const actor of [OWNER, BORROWER]) {
        expect(resolveTransition('HANDED_OVER', action, actor, 'RECORDED_EXISTING')).toEqual({
          kind: 'refused',
          reason: 'STATE',
        })
      }
    }

    expect(transitionOf('HANDED_OVER', 'return', OWNER, 'RECORDED_EXISTING').event).toBe(
      'LOAN_RETURNED',
    )
    expect(transitionOf('HANDED_OVER', 'mark_lost', OWNER, 'RECORDED_EXISTING').event).toBe(
      'LOAN_LOST',
    )
    expect(transitionOf('LOST', 'recover', OWNER, 'RECORDED_EXISTING').event).toBe('RECOVERED')
  })

  it('return request-flow позики подій не пише (без задніх подій, §6.8)', () => {
    expect(transitionOf('HANDED_OVER', 'return', OWNER, 'REQUESTED').event).toBeNull()
  })

  it('дії request-flow над записаною позикою неможливі (STATE) навіть із синтетичним REQUESTED/APPROVED', () => {
    for (const from of ['REQUESTED', 'APPROVED'] as const) {
      for (const action of ['approve', 'reject', 'cancel', 'hand_over'] as const) {
        for (const actor of [OWNER, BORROWER]) {
          expect(resolveTransition(from, action, actor, 'RECORDED_EXISTING')).toEqual({
            kind: 'refused',
            reason: 'STATE',
          })
        }
      }
    }

    for (const action of ['approve', 'reject', 'cancel', 'hand_over'] as const) {
      expect(resolveTransition('PENDING_CONFIRMATION', action, OWNER, 'RECORDED_EXISTING')).toEqual(
        { kind: 'refused', reason: 'STATE' },
      )
    }
  })

  it('дії запису над origin=REQUESTED неможливі', () => {
    for (const from of LOAN_STATUS) {
      for (const action of [
        'confirm_record',
        'decline_record',
        'withdraw_record',
        'amend_record',
      ] as const) {
        for (const actor of [OWNER, BORROWER]) {
          expect(resolveTransition(from, action, actor, 'REQUESTED')).toEqual({
            kind: 'refused',
            reason: 'STATE',
          })
        }
      }
    }
  })

  it('RECORDED_GUEST у 10e не має жодного переходу', () => {
    for (const from of LOAN_STATUS) {
      for (const action of LOAN_ACTIONS) {
        expect('kind' in resolveTransition(from, action, OWNER, 'RECORDED_GUEST')).toBe(true)
      }
    }
  })
})

function transitionOf(
  from: LoanStatus,
  action: LoanAction,
  actor: LoanActor,
  origin: LoanOrigin,
): LoanTransition {
  const outcome = resolveTransition(from, action, actor, origin)

  if ('kind' in outcome) throw new Error(`Очікувався перехід ${from} --${action}--> (${origin})`)

  return outcome
}
