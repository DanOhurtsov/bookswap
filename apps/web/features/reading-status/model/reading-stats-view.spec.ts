import { ApiRequestError } from '@/app/lib/api'
import { toReadingStatsView, type ReadingStatsViewInput } from './reading-stats-view'

const counts = (NOT_READ: number, READING: number, READ: number) => ({
  counts: { NOT_READ, READING, READ },
})

const input = (overrides: Partial<ReadingStatsViewInput>): ReadingStatsViewInput => ({
  data: undefined,
  error: null,
  isError: false,
  isRefreshingOutdated: false,
  ...overrides,
})

describe('toReadingStatsView (BS-145)', () => {
  it('is loading until the first answer', () => {
    expect(toReadingStatsView(input({}))).toEqual({ kind: 'loading' })
  })

  it('lists all three statuses in their usual order with their labels, zeros included', () => {
    expect(toReadingStatsView(input({ data: counts(0, 2, 0) }))).toEqual({
      kind: 'ready',
      items: [
        { status: 'NOT_READ', label: 'Не читав', count: 0 },
        { status: 'READING', label: 'Читаю', count: 2 },
        { status: 'READ', label: 'Прочитано', count: 0 },
      ],
    })
  })

  it('an explicit NOT_READ alone is not empty', () => {
    expect(toReadingStatsView(input({ data: counts(1, 0, 0) })).kind).toBe('ready')
  })

  it('no status set at all is the empty state, not three zeros', () => {
    expect(toReadingStatsView(input({ data: counts(0, 0, 0) }))).toEqual({ kind: 'empty' })
  })

  it('a failed read is an error with the reason, never zeros', () => {
    const error = new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'API впав' })

    expect(toReadingStatsView(input({ isError: true, error }))).toEqual({
      kind: 'error',
      message: 'Не вдалося завантажити статистику читання. API впав',
    })
  })

  it('a failed refresh hides the counts it still holds: they are no longer known to be current', () => {
    const view = toReadingStatsView(
      input({ data: counts(1, 2, 3), isError: true, error: new Error('offline') }),
    )

    expect(view.kind).toBe('error')
  })

  it('counts marked out of date by a saved status wait for the new answer instead of flashing', () => {
    expect(
      toReadingStatsView(input({ data: counts(1, 2, 3), isRefreshingOutdated: true })),
    ).toEqual({ kind: 'loading' })
  })
})
