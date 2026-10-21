import { ApiRequestError } from '@/app/lib/api'
import { loadReadingStatus } from './reading-status-batch'

/** BS-140: the transport that turns the reads of one tick into one request. Only `apiRequest` is mocked. */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const BATCH = '/me/reading-statuses?workIds='

function statusOf(workId: string) {
  return { workId, status: 'READ', isSet: true, wasBorrowed: false }
}

/** Answers every batch with each requested id, except those in `missing`. */
function serve(missing: string[] = []): void {
  apiRequest.mockImplementation((path: string) => {
    if (path.startsWith(BATCH)) {
      const ids = path.slice(BATCH.length).split(',').map(decodeURIComponent)

      return Promise.resolve({
        items: ids
          .filter((id) => !missing.includes(id))
          .map((id) => ({ requestedWorkId: id, ...statusOf(id) })),
      })
    }

    const single = /^\/me\/reading-statuses\/(.+)$/.exec(path)

    if (single?.[1] !== undefined) return Promise.resolve(statusOf(decodeURIComponent(single[1])))

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function paths(): string[] {
  return apiRequest.mock.calls.map(([path]) => path as string)
}

function batchIds(path: string): string[] {
  return path.slice(BATCH.length).split(',')
}

beforeEach(() => {
  apiRequest.mockReset()
  serve()
})

describe('loadReadingStatus (BS-140)', () => {
  it('reads asked for in one tick go out as one batch, and each caller gets its own work', async () => {
    const answers = await Promise.all(['w-1', 'w-2', 'w-3'].map(loadReadingStatus))

    expect(paths()).toEqual([`${BATCH}w-1,w-2,w-3`])
    expect(answers.map((answer) => answer.workId)).toEqual(['w-1', 'w-2', 'w-3'])
    // The batch's own bookkeeping does not leak into the cached status.
    expect(answers[0]).toEqual(statusOf('w-1'))
  })

  it('a repeated id is asked for once and answers every caller', async () => {
    const answers = await Promise.all(['w-1', 'w-2', 'w-1'].map(loadReadingStatus))

    expect(paths()).toEqual([`${BATCH}w-1,w-2`])
    expect(answers.map((answer) => answer.workId)).toEqual(['w-1', 'w-2', 'w-1'])
  })

  it('a lone read uses the single-work route, as before', async () => {
    await loadReadingStatus('w-1')

    expect(paths()).toEqual(['/me/reading-statuses/w-1'])
  })

  it('reads of different ticks are different requests', async () => {
    await loadReadingStatus('w-1')
    await Promise.all(['w-2', 'w-3'].map(loadReadingStatus))

    expect(paths()).toEqual(['/me/reading-statuses/w-1', `${BATCH}w-2,w-3`])
  })

  it('more than 100 works go out in batches of at most 100, and none is lost', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `w-${String(index)}`)
    const answers = await Promise.all(ids.map(loadReadingStatus))

    expect(paths().map((path) => batchIds(path).length)).toEqual([100, 100, 5])
    expect(paths().flatMap(batchIds)).toEqual(ids)
    expect(answers.map((answer) => answer.workId)).toEqual(ids)
  })

  it('a work the batch leaves out fails with «not found»; the rest of the batch is answered', async () => {
    serve(['gone'])

    const [kept, gone] = await Promise.allSettled(['w-1', 'gone'].map(loadReadingStatus))

    expect(kept).toEqual({ status: 'fulfilled', value: statusOf('w-1') })
    expect(gone).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({ status: 404, code: 'NOT_FOUND' }) as unknown,
    })
    expect((gone as PromiseRejectedResult).reason).toBeInstanceOf(ApiRequestError)
  })

  it('a failed batch fails only its own works; another batch of the same tick is answered', async () => {
    const failure = new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Немає звʼязку' })
    let call = 0

    apiRequest.mockImplementation((path: string) => {
      call += 1

      if (call === 1) return Promise.reject(failure)

      return Promise.resolve({
        items: batchIds(path).map((id) => ({ requestedWorkId: id, ...statusOf(id) })),
      })
    })

    const ids = Array.from({ length: 101 }, (_, index) => `w-${String(index)}`)
    const results = await Promise.allSettled(ids.map(loadReadingStatus))

    expect(results.slice(0, 100).every((result) => result.status === 'rejected')).toBe(true)
    expect((results[0] as PromiseRejectedResult).reason).toBe(failure)
    expect(results[100]).toEqual({ status: 'fulfilled', value: statusOf('w-100') })
  })
})
