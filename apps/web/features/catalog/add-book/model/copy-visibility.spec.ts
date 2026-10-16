import type { QuickAddRequest, Visibility } from '@bookswap/shared'
import { copyVisibilityView, initialCopyVisibility } from './copy-visibility'
import type { QuickAddSlot } from './quick-add-slots'

const OPERATION_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'

function request(visibility?: Visibility): QuickAddRequest {
  return {
    operationId: OPERATION_ID,
    ...(visibility === undefined ? {} : { copy: { visibility } }),
    target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
  }
}

describe('initialCopyVisibility (BS-79)', () => {
  it.each<Visibility>(['PUBLIC', 'FRIENDS', 'PRIVATE'])(
    'бібліотека %s → новий примірник починає з того самого значення',
    (visibility) => {
      expect(initialCopyVisibility(visibility)).toBe(visibility)
    },
  )

  it.each([undefined, null, '', 'SECRET', 'public', 42])(
    'відсутнє чи невалідне значення профілю (%p) → FRIENDS',
    (value) => {
      expect(initialCopyVisibility(value)).toBe('FRIENDS')
    },
  )
})

describe('copyVisibilityView (BS-79)', () => {
  it('без операції — чернетка, яку можна змінити', () => {
    expect(copyVisibilityView(undefined, 'PRIVATE')).toEqual({ value: 'PRIVATE', isLocked: false })
  })

  it.each<QuickAddSlot>([
    { status: 'rejected', added: 0, message: 'Ні' },
    { status: 'done', added: 1, copyId: 'c-1', editionId: 'e-1' },
  ])('після відомого результату ($status) — знову чернетка', (slot) => {
    expect(copyVisibilityView(slot, 'PUBLIC')).toEqual({ value: 'PUBLIC', isLocked: false })
  })

  it.each<QuickAddSlot>([
    { status: 'pending', operationId: OPERATION_ID, request: request('PRIVATE'), added: 0 },
    {
      status: 'unknown',
      operationId: OPERATION_ID,
      request: request('PRIVATE'),
      added: 0,
      message: 'Не підтверджено',
    },
  ])('поки операція $status — показує надіслане значення, а не чернетку, і заблоковано', (slot) => {
    expect(copyVisibilityView(slot, 'PUBLIC')).toEqual({ value: 'PRIVATE', isLocked: true })
  })

  it('операція без явної видимості (діалог пошуку) — порожнє значення: вирішує сервер', () => {
    const slot: QuickAddSlot = {
      status: 'pending',
      operationId: OPERATION_ID,
      request: request(),
      added: 0,
    }

    expect(copyVisibilityView(slot, 'PUBLIC')).toEqual({ value: '', isLocked: true })
  })

  describe('після однозначної відмови', () => {
    const rejected = (visibility?: Visibility): QuickAddSlot => ({
      status: 'rejected',
      added: 0,
      message: 'Ні',
      operationId: OPERATION_ID,
      request: request(visibility),
    })

    it('показує надіслане відхиленою операцією значення й відкриває вибір', () => {
      expect(copyVisibilityView(rejected('PRIVATE'), 'PUBLIC')).toEqual({
        value: 'PRIVATE',
        isLocked: false,
      })
    })

    it('лише раз: вибір, зроблений після цієї операції, — вже чернетка людини', () => {
      expect(copyVisibilityView(rejected('PRIVATE'), 'FRIENDS', OPERATION_ID)).toEqual({
        value: 'FRIENDS',
        isLocked: false,
      })
    })

    it('вибір, зроблений після ІНШОЇ операції, не скасовує повернення', () => {
      expect(copyVisibilityView(rejected('PRIVATE'), 'FRIENDS', 'інша-операція')).toEqual({
        value: 'PRIVATE',
        isLocked: false,
      })
    })

    it('операція без явної видимості (діалог пошуку) нічого не повертає — лишається чернетка', () => {
      expect(copyVisibilityView(rejected(), 'PUBLIC')).toEqual({ value: 'PUBLIC', isLocked: false })
    })
  })
})
