import { ApiRequestError } from '@/app/lib/api'
import {
  asReadingStatus,
  toReadingStatusView,
  type ReadingStatusViewInput,
} from './reading-status-view'

const IDLE: ReadingStatusViewInput['own'] = {
  status: 'idle',
  variables: undefined,
  data: undefined,
  error: null,
}

function input(overrides: Partial<ReadingStatusViewInput> = {}): ReadingStatusViewInput {
  return {
    query: {
      data: { workId: 'w-1', status: 'NOT_READ', isSet: false, wasBorrowed: false },
      error: null,
      isPending: false,
    },
    saving: [],
    own: IDLE,
    ...overrides,
  }
}

describe('toReadingStatusView (BS-140)', () => {
  it('no record is «not set» (null), not NOT_READ; an explicit NOT_READ is NOT_READ', () => {
    expect(toReadingStatusView(input())).toMatchObject({ kind: 'ready', current: null })
    expect(
      toReadingStatusView(
        input({
          query: {
            data: { workId: 'w-1', status: 'NOT_READ', isSet: true, wasBorrowed: true },
            error: null,
            isPending: false,
          },
        }),
      ),
    ).toMatchObject({ kind: 'ready', current: 'NOT_READ', wasBorrowed: true })
  })

  it('loading before any answer; a failed read is an error with its message, never «not set»', () => {
    expect(
      toReadingStatusView(input({ query: { data: undefined, error: null, isPending: true } })),
    ).toEqual({ kind: 'loading' })

    expect(
      toReadingStatusView(
        input({
          query: {
            data: undefined,
            error: new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Немає звʼязку' }),
            isPending: false,
          },
        }),
      ),
    ).toEqual({ kind: 'error', message: 'Немає звʼязку' })
  })

  it('a failed refresh keeps the data already on screen', () => {
    const view = toReadingStatusView(
      input({
        query: {
          data: { workId: 'w-1', status: 'READ', isSet: true, wasBorrowed: false },
          error: new Error('refresh failed'),
          isPending: false,
        },
      }),
    )

    expect(view).toMatchObject({ kind: 'ready', current: 'READ' })
  })

  it('a save in flight from any control locks this one; its own success and failure are its own', () => {
    expect(toReadingStatusView(input({ saving: ['READ'] }))).toMatchObject({ saving: 'READ' })

    expect(
      toReadingStatusView(
        input({
          own: {
            status: 'success',
            variables: 'READ',
            data: { workId: 'w-1', status: 'READ' },
            error: null,
          },
        }),
      ),
    ).toMatchObject({ saved: 'READ', saveError: undefined, failed: undefined })

    const apiFailure = new ApiRequestError(503, {
      code: 'INTERNAL_ERROR',
      message: 'Сервер недоступний',
    })
    const failed = toReadingStatusView(
      input({ own: { status: 'error', variables: 'READING', data: undefined, error: apiFailure } }),
    )

    // The confirmed status stays: nothing was written for a failed save.
    expect(failed).toMatchObject({ current: null, saved: undefined, failed: 'READING' })
    expect(failed.kind === 'ready' && failed.saveError).toBe(apiFailure)
  })

  it('a failure that is not from the API is described in words', () => {
    const view = toReadingStatusView(
      input({ own: { status: 'error', variables: 'READ', data: undefined, error: 'boom' } }),
    )

    expect(view.kind === 'ready' && view.saveError).toBeInstanceOf(Error)
  })
})

describe('asReadingStatus', () => {
  it('keeps a status and drops anything else', () => {
    expect(asReadingStatus('READING')).toBe('READING')
    expect(asReadingStatus('reading')).toBeUndefined()
    expect(asReadingStatus(undefined)).toBeUndefined()
  })
})
