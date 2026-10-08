import type { QuickAddRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import {
  EMPTY_SLOTS,
  classifyFailure,
  newOperationId,
  quickAddSlotsReducer,
  slotKeyOf,
  slotOf,
  type QuickAddSlotsState,
} from './quick-add-slots'

const OPERATION = '3f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11'
const request: QuickAddRequest = {
  operationId: OPERATION,
  target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
}

function started(state: QuickAddSlotsState = EMPTY_SLOTS): QuickAddSlotsState {
  return quickAddSlotsReducer(state, {
    type: 'started',
    key: 'edition:e-1',
    identities: ['edition:e-1', 'isbn:9780000000002'],
    operationId: OPERATION,
    request,
  })
}

describe('quickAddSlotsReducer', () => {
  it('усі ідентичності видання ведуть в один слот', () => {
    const state = started()

    expect(slotKeyOf(state, ['isbn:9780000000002'])).toBe('edition:e-1')
    expect(slotOf(state, ['isbn:9780000000002'])).toMatchObject({ status: 'pending' })
    expect(slotOf(state, ['edition:e-1'])).toBe(slotOf(state, ['isbn:9780000000002']))
  })

  it('невідомий результат лишає ту саму операцію й вміст для повтору', () => {
    const state = quickAddSlotsReducer(started(), {
      type: 'unknown',
      key: 'edition:e-1',
      message: 'мережа',
    })

    expect(slotOf(state, ['edition:e-1'])).toEqual({
      status: 'unknown',
      operationId: OPERATION,
      request,
      added: 0,
      message: 'мережа',
    })
  })

  it('«невідомо» не виникає з нічого', () => {
    expect(
      quickAddSlotsReducer(EMPTY_SLOTS, { type: 'unknown', key: 'edition:e-1', message: 'x' }),
    ).toBe(EMPTY_SLOTS)
  })

  it('успіх додає псевдонім за editionId і рахує примірники цього сеансу', () => {
    const first = quickAddSlotsReducer(started(), {
      type: 'done',
      key: 'edition:e-1',
      identities: ['gb:vol-1'],
      copyId: 'c-1',
      editionId: 'e-1',
    })

    expect(slotOf(first, ['gb:vol-1'])).toMatchObject({ status: 'done', added: 1, copyId: 'c-1' })

    const second = quickAddSlotsReducer(
      quickAddSlotsReducer(first, {
        type: 'started',
        key: 'edition:e-1',
        identities: ['edition:e-1'],
        operationId: '11111111-1111-4111-8111-111111111111',
        request,
      }),
      { type: 'done', key: 'edition:e-1', identities: [], copyId: 'c-2', editionId: 'e-1' },
    )

    expect(slotOf(second, ['edition:e-1'])).toMatchObject({ status: 'done', added: 2 })
  })

  it('відмова зберігає лічильник уже доданих примірників', () => {
    const done = quickAddSlotsReducer(started(), {
      type: 'done',
      key: 'edition:e-1',
      identities: [],
      copyId: 'c-1',
      editionId: 'e-1',
    })
    const rejected = quickAddSlotsReducer(done, {
      type: 'rejected',
      key: 'edition:e-1',
      message: 'ні',
    })

    expect(slotOf(rejected, ['edition:e-1'])).toEqual({
      status: 'rejected',
      added: 1,
      message: 'ні',
    })
  })

  it('слот без жодної ідентичності неможливий', () => {
    expect(() => slotKeyOf(EMPTY_SLOTS, [])).toThrow()
  })
})

describe('classifyFailure', () => {
  const api = (status: number): ApiRequestError =>
    new ApiRequestError(status, { code: 'INTERNAL_ERROR', message: 'x' })

  it.each([
    [400, 'rejected'],
    [404, 'rejected'],
    [409, 'rejected'],
    [422, 'rejected'],
    [408, 'unknown'],
    [429, 'unknown'],
    [500, 'unknown'],
    [502, 'unknown'],
    [504, 'unknown'],
  ] as const)('HTTP %i → %s', (status, kind) => {
    expect(classifyFailure(api(status))).toBe(kind)
  })

  it('обрив мережі й відповідь, що не розібралася, — результат невідомий', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('unknown')
    expect(classifyFailure(new Error('Відповідь API не відповідає спільному контракту'))).toBe(
      'unknown',
    )
  })
})

describe('newOperationId', () => {
  it('дає UUID v4', () => {
    expect(newOperationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('кожен виклик — новий ключ', () => {
    expect(newOperationId()).not.toBe(newOperationId())
  })
})
