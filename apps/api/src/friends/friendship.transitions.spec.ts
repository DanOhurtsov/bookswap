import { FRIENDSHIP_STATUS } from '@bookswap/shared'
import type { ActorRole, FriendshipState } from '../access/friendship.pair'
import {
  resolveTransition,
  type FriendshipAction,
  type TransitionResult,
} from './friendship.transitions'

/**
 * Повна матриця переходів §6.2 — усі дозволені й усі заборонені.
 *
 * Тест ганяє декартів добуток «стан × дія × роль» і звіряє з таблицею нижче, тож
 * новий стан або нова дія без запису в таблиці одразу дає червоне. Саме заради
 * цього стейт-машина чиста: покрити те саме крізь HTTP означало б сотні запитів
 * до бази заради логіки, у якій немає ні бази, ні мережі.
 */

const STATES: readonly FriendshipState[] = ['NONE', ...FRIENDSHIP_STATUS]
const ACTIONS: readonly FriendshipAction[] = [
  'request',
  'accept',
  'decline',
  'remove',
  'block',
  'invite',
]
const ROLES: readonly ActorRole[] = ['NONE', 'REQUESTER', 'RECIPIENT', 'BLOCKER', 'BLOCKED']

const created = (status: 'PENDING' | 'BLOCKED' | 'ACCEPTED'): TransitionResult => ({
  kind: 'create',
  status,
})
const updated = (to: (typeof FRIENDSHIP_STATUS)[number]): TransitionResult => ({
  kind: 'update',
  to,
})
const deleted: TransitionResult = { kind: 'delete' }
const refused = (reason: 'BLOCKED' | 'EXISTS' | 'ROLE' | 'STATE'): TransitionResult => ({
  kind: 'refused',
  reason,
})

/**
 * Очікуваний результат для кожної комбінації.
 *
 * Роль читається лише там, де вона щось означає: у стані `NONE` рядка немає, тож
 * будь-яка роль дає той самий результат.
 */
function expected(
  state: FriendshipState,
  action: FriendshipAction,
  role: ActorRole,
): TransitionResult {
  if (state === 'BLOCKED') {
    return action === 'remove' && role === 'BLOCKER' ? deleted : refused('BLOCKED')
  }

  if (action === 'invite') {
    if (state === 'NONE') return created('ACCEPTED')
    if (state === 'ACCEPTED') return { kind: 'unchanged' }

    return updated('ACCEPTED')
  }

  if (action === 'block') {
    return state === 'NONE' ? created('BLOCKED') : updated('BLOCKED')
  }

  if (action === 'remove') {
    return state === 'NONE' ? refused('STATE') : deleted
  }

  if (action === 'request') {
    if (state === 'NONE') return created('PENDING')
    if (state === 'DECLINED') return updated('PENDING')
    if (state === 'PENDING') return role === 'RECIPIENT' ? updated('ACCEPTED') : refused('EXISTS')

    return refused('EXISTS')
  }

  // accept / decline
  if (state !== 'PENDING') return refused('STATE')
  if (role !== 'RECIPIENT') return refused('ROLE')

  return updated(action === 'accept' ? 'ACCEPTED' : 'DECLINED')
}

describe('resolveTransition — уся матриця', () => {
  for (const state of STATES) {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        it(`${state} × ${action} × ${role}`, () => {
          expect(resolveTransition(state, action, role)).toEqual(expected(state, action, role))
        })
      }
    }
  }

  it('покриває всі стани й дії, які існують у домені', () => {
    expect(STATES).toHaveLength(FRIENDSHIP_STATUS.length + 1)
    expect(ACTIONS).toHaveLength(6)
  })
})

describe('дозволені переходи — те, що має працювати', () => {
  it('незнайомі → запит', () => {
    expect(resolveTransition('NONE', 'request', 'NONE')).toEqual(created('PENDING'))
  })

  it('отримувач приймає запит', () => {
    expect(resolveTransition('PENDING', 'accept', 'RECIPIENT')).toEqual(updated('ACCEPTED'))
  })

  it('отримувач відхиляє запит', () => {
    expect(resolveTransition('PENDING', 'decline', 'RECIPIENT')).toEqual(updated('DECLINED'))
  })

  it('ініціатор скасовує власний запит через remove, а не decline', () => {
    expect(resolveTransition('PENDING', 'remove', 'REQUESTER')).toEqual(deleted)
    expect(resolveTransition('PENDING', 'decline', 'REQUESTER')).toEqual(refused('ROLE'))
  })

  it('після відмови можна надіслати запит знову — DECLINED не вирок', () => {
    expect(resolveTransition('DECLINED', 'request', 'REQUESTER')).toEqual(updated('PENDING'))
    expect(resolveTransition('DECLINED', 'request', 'RECIPIENT')).toEqual(updated('PENDING'))
  })

  it('зустрічний запит = згода: пара одразу стає ACCEPTED', () => {
    expect(resolveTransition('PENDING', 'request', 'RECIPIENT')).toEqual(updated('ACCEPTED'))
  })

  it('розійтися може будь-хто з пари', () => {
    expect(resolveTransition('ACCEPTED', 'remove', 'REQUESTER')).toEqual(deleted)
    expect(resolveTransition('ACCEPTED', 'remove', 'RECIPIENT')).toEqual(deleted)
  })

  it.each(['NONE', ...FRIENDSHIP_STATUS.filter((status) => status !== 'BLOCKED')])(
    'заблокувати можна зі стану %s',
    (state) => {
      const result = resolveTransition(state as FriendshipState, 'block', 'REQUESTER')

      expect(result.kind === 'create' || result.kind === 'update').toBe(true)
    },
  )

  it('блок знімає той, хто його поставив', () => {
    expect(resolveTransition('BLOCKED', 'remove', 'BLOCKER')).toEqual(deleted)
  })
})

describe('заборонені переходи — те, що має ламатися', () => {
  it('не можна прийняти чи відхилити власний запит', () => {
    expect(resolveTransition('PENDING', 'accept', 'REQUESTER')).toEqual(refused('ROLE'))
    expect(resolveTransition('PENDING', 'decline', 'REQUESTER')).toEqual(refused('ROLE'))
  })

  it('повторний запит від того самого ініціатора — конфлікт, а не другий рядок', () => {
    expect(resolveTransition('PENDING', 'request', 'REQUESTER')).toEqual(refused('EXISTS'))
  })

  it('не можна надіслати запит тому, хто вже друг', () => {
    expect(resolveTransition('ACCEPTED', 'request', 'REQUESTER')).toEqual(refused('EXISTS'))
    expect(resolveTransition('ACCEPTED', 'request', 'RECIPIENT')).toEqual(refused('EXISTS'))
  })

  it('не можна прийняти те, чого не надсилали', () => {
    expect(resolveTransition('NONE', 'accept', 'NONE')).toEqual(refused('STATE'))
    expect(resolveTransition('ACCEPTED', 'accept', 'RECIPIENT')).toEqual(refused('STATE'))
    expect(resolveTransition('DECLINED', 'accept', 'RECIPIENT')).toEqual(refused('STATE'))
  })

  it('не можна прибрати звʼязок, якого немає', () => {
    expect(resolveTransition('NONE', 'remove', 'NONE')).toEqual(refused('STATE'))
  })

  it.each(['request', 'accept', 'decline', 'block'] as FriendshipAction[])(
    'BLOCKED забороняє %s обом сторонам (§6.2)',
    (action) => {
      for (const role of ROLES) {
        expect(resolveTransition('BLOCKED', action, role)).toEqual(refused('BLOCKED'))
      }
    },
  )

  it('заблокований не знімає блок сам — інакше блокування не означало б нічого', () => {
    expect(resolveTransition('BLOCKED', 'remove', 'BLOCKED')).toEqual(refused('BLOCKED'))
    expect(resolveTransition('BLOCKED', 'remove', 'RECIPIENT')).toEqual(refused('BLOCKED'))
  })
})

describe('прийняття запрошення (Етап 9)', () => {
  it('незнайомі → одразу ACCEPTED: обидві згоди вже є', () => {
    expect(resolveTransition('NONE', 'invite', 'NONE')).toEqual(created('ACCEPTED'))
  })

  it('висячий запит у будь-який бік стає дружбою', () => {
    expect(resolveTransition('PENDING', 'invite', 'REQUESTER')).toEqual(updated('ACCEPTED'))
    expect(resolveTransition('PENDING', 'invite', 'RECIPIENT')).toEqual(updated('ACCEPTED'))
  })

  it('повторне прийняття ідемпотентне', () => {
    expect(resolveTransition('ACCEPTED', 'invite', 'REQUESTER')).toEqual({ kind: 'unchanged' })
  })

  it('блок у будь-який бік — відмова, дружбу не створити запрошенням', () => {
    expect(resolveTransition('BLOCKED', 'invite', 'BLOCKER')).toEqual(refused('BLOCKED'))
    expect(resolveTransition('BLOCKED', 'invite', 'BLOCKED')).toEqual(refused('BLOCKED'))
  })
})
