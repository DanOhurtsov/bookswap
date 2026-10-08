import { ApiRequestError, describeError } from '@/app/lib/api'
import {
  canRecordHandover,
  canToggleOwnerStatus,
  emptyMessage,
  nextOwnerStatus,
  toFailure,
} from './copy-rules'

const STATUSES = ['AVAILABLE', 'RESERVED', 'LENT_OUT', 'UNAVAILABLE'] as const

describe('canToggleOwnerStatus', () => {
  it.each([
    [true, 'AVAILABLE', true],
    [true, 'UNAVAILABLE', true],
    [true, 'RESERVED', false],
    [true, 'LENT_OUT', false],
    [false, 'AVAILABLE', false],
    [false, 'UNAVAILABLE', false],
    [false, 'RESERVED', false],
    [false, 'LENT_OUT', false],
  ] as const)('isHome=%s, status=%s → %s', (isHome, status, expected) => {
    expect(canToggleOwnerStatus({ isHome, status })).toBe(expected)
  })
})

describe('canRecordHandover', () => {
  it('only a free copy at home can be handed over', () => {
    const allowed = STATUSES.flatMap((status) =>
      [true, false]
        .filter((isHome) => canRecordHandover({ isHome, status }))
        .map((isHome) => ({ isHome, status })),
    )

    expect(allowed).toEqual([{ isHome: true, status: 'AVAILABLE' }])
  })
})

describe('nextOwnerStatus', () => {
  it('flips between the two owner states', () => {
    expect(nextOwnerStatus('AVAILABLE')).toBe('UNAVAILABLE')
    expect(nextOwnerStatus('UNAVAILABLE')).toBe('AVAILABLE')
  })
})

describe('emptyMessage', () => {
  it('has a distinct message for every view', () => {
    const messages = (['own', 'out', 'borrowed', 'archive'] as const).map(emptyMessage)

    expect(new Set(messages).size).toBe(4)
    expect(messages.every((message) => message !== '')).toBe(true)
  })

  it('says what the user can do on an empty own shelf', () => {
    expect(emptyMessage('own')).toBe(
      'Полиця порожня. Знайдіть книжку в каталозі — і додайте примірник.',
    )
  })
})

describe('toFailure', () => {
  it('keeps an API error as it is, so its code and constraints survive', () => {
    const error = new ApiRequestError(409, { code: 'CONFLICT', message: 'Конфлікт' })

    expect(toFailure(error)).toBe(error)
  })

  it.each([new Error('boom'), 'text', undefined])('wraps %p in the generic message', (error) => {
    const failure = toFailure(error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(ApiRequestError)
    expect(failure.message).toBe(describeError(error))
  })
})
