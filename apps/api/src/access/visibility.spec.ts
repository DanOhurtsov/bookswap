import { VISIBILITY, type Visibility } from '@bookswap/shared'
import {
  copyVisibleTo,
  holderNamesVisibleTo,
  isVisibleTo,
  mayRequestLoan,
  strictestVisibility,
  type ViewerRole,
} from './visibility'

const ROLES: readonly ViewerRole[] = ['OWNER', 'FRIEND', 'FRIEND_OF_FRIEND', 'OTHER', 'BLOCKED']

describe('strictestVisibility', () => {
  it.each([
    ['PUBLIC', 'PUBLIC', 'PUBLIC'],
    ['PUBLIC', 'FRIENDS', 'FRIENDS'],
    ['PUBLIC', 'PRIVATE', 'PRIVATE'],
    ['FRIENDS', 'PUBLIC', 'FRIENDS'],
    ['FRIENDS', 'FRIENDS', 'FRIENDS'],
    ['FRIENDS', 'PRIVATE', 'PRIVATE'],
    ['PRIVATE', 'PUBLIC', 'PRIVATE'],
    ['PRIVATE', 'FRIENDS', 'PRIVATE'],
    ['PRIVATE', 'PRIVATE', 'PRIVATE'],
  ] as [Visibility, Visibility, Visibility][])('%s + %s = %s', (one, other, expected) => {
    expect(strictestVisibility(one, other)).toBe(expected)
  })

  it('комутативна — порядок аргументів не має значення', () => {
    for (const one of VISIBILITY) {
      for (const other of VISIBILITY) {
        expect(strictestVisibility(one, other)).toBe(strictestVisibility(other, one))
      }
    }
  })
})

describe('isVisibleTo — §9, рядки «Бібліотека»', () => {
  // Повна матриця 3×3 з таблиці §9.
  const MATRIX: Record<ViewerRole, Record<Visibility, boolean>> = {
    OWNER: { PUBLIC: true, FRIENDS: true, PRIVATE: true },
    FRIEND: { PUBLIC: true, FRIENDS: true, PRIVATE: false },
    // BS-148: the owner opened the library to friends of friends — the role exists only then.
    FRIEND_OF_FRIEND: { PUBLIC: true, FRIENDS: true, PRIVATE: false },
    OTHER: { PUBLIC: true, FRIENDS: false, PRIVATE: false },
    // §6.2: заблокований не бачить бібліотеку. Крапка — без винятку для PUBLIC.
    BLOCKED: { PUBLIC: false, FRIENDS: false, PRIVATE: false },
  }

  for (const role of ROLES) {
    for (const visibility of VISIBILITY) {
      const expected = MATRIX[role][visibility]

      it(`${role} × ${visibility} → ${String(expected)}`, () => {
        expect(isVisibleTo(role, visibility)).toBe(expected)
      })
    }
  }

  it('власник бачить власну PRIVATE-бібліотеку — приватність не ховає її від нього', () => {
    expect(isVisibleTo('OWNER', 'PRIVATE')).toBe(true)
  })

  it.each([...VISIBILITY])('заблокований не бачить бібліотеку з видимістю %s', (visibility) => {
    expect(isVisibleTo('BLOCKED', visibility)).toBe(false)
  })

  it('BLOCKED суворіший за OTHER саме на PUBLIC — там, де їх легко сплутати', () => {
    // Якби роль BLOCKED зводилася до OTHER, різниця була б рівно тут — і саме
    // власники відкритих бібліотек не помітили б, що блокування не працює.
    expect(isVisibleTo('OTHER', 'PUBLIC')).toBe(true)
    expect(isVisibleTo('BLOCKED', 'PUBLIC')).toBe(false)
  })
})

describe('copyVisibleTo — §9, «найсуворіша з двох»', () => {
  // 3 ролі × 3 видимості бібліотеки × 3 видимості примірника = 27 комбінацій.
  for (const role of ROLES) {
    for (const library of VISIBILITY) {
      for (const copy of VISIBILITY) {
        const expected = isVisibleTo(role, strictestVisibility(library, copy))

        it(`${role} × бібліотека ${library} × примірник ${copy} → ${String(expected)}`, () => {
          expect(copyVisibleTo(role, library, copy)).toBe(expected)
        })
      }
    }
  }

  it('PUBLIC-примірник у PRIVATE-бібліотеці лишається схованим від друга', () => {
    expect(copyVisibleTo('FRIEND', 'PRIVATE', 'PUBLIC')).toBe(false)
  })

  it('PRIVATE-примірник у PUBLIC-бібліотеці схований від стороннього і від друга', () => {
    expect(copyVisibleTo('OTHER', 'PUBLIC', 'PRIVATE')).toBe(false)
    expect(copyVisibleTo('FRIEND', 'PUBLIC', 'PRIVATE')).toBe(false)
  })

  it('власник бачить будь-яку свою комбінацію', () => {
    for (const library of VISIBILITY) {
      for (const copy of VISIBILITY) {
        expect(copyVisibleTo('OWNER', library, copy)).toBe(true)
      }
    }
  })

  it('заблокований не бачить ЖОДНОЇ комбінації, включно з PUBLIC × PUBLIC', () => {
    for (const library of VISIBILITY) {
      for (const copy of VISIBILITY) {
        expect(copyVisibleTo('BLOCKED', library, copy)).toBe(false)
      }
    }
  })
})

describe('holderNamesVisibleTo — §6.6', () => {
  it.each([
    ['OWNER', true, true],
    ['OWNER', false, true],
    ['FRIEND', true, true],
    ['FRIEND', false, false],
    ['FRIEND_OF_FRIEND', true, false],
    ['FRIEND_OF_FRIEND', false, false],
    ['OTHER', true, false],
    ['OTHER', false, false],
    ['BLOCKED', true, false],
    ['BLOCKED', false, false],
  ] as [ViewerRole, boolean, boolean][])(
    '%s × showHolderNames=%s → %s',
    (role, showHolderNames, expected) => {
      expect(holderNamesVisibleTo(role, showHolderNames)).toBe(expected)
    },
  )

  it('власник бачить імена навіть із вимкненим прапорцем — він налаштовує чужий погляд', () => {
    expect(holderNamesVisibleTo('OWNER', false)).toBe(true)
  })

  it('сторонній не бачить імен навіть з увімкненим — §9 не дає йому історії взагалі', () => {
    expect(holderNamesVisibleTo('OTHER', true)).toBe(false)
  })

  it('заблокований не бачить імен за жодного значення прапорця', () => {
    expect(holderNamesVisibleTo('BLOCKED', true)).toBe(false)
    expect(holderNamesVisibleTo('BLOCKED', false)).toBe(false)
  })
})

describe('mayRequestLoan — §9, «Створити запит на позичання»', () => {
  it.each([
    ['OWNER', false],
    ['FRIEND', true],
    ['FRIEND_OF_FRIEND', true],
    ['OTHER', false],
    ['BLOCKED', false],
  ] as [ViewerRole, boolean][])('%s → %s', (role, expected) => {
    expect(mayRequestLoan(role)).toBe(expected)
  })
})
