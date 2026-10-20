import {
  API_ERROR_CODES,
  READING_STATUS_BATCH_LIMITS,
  type ReadingStatusResponse,
  type ReadingStatusesResponse,
} from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { fetchReadingStatus, fetchReadingStatuses } from './reading-status-requests'

interface Waiter {
  resolve: (value: ReadingStatusResponse) => void
  reject: (reason: unknown) => void
}

/** The ids asked for since the last flush, each with everyone waiting for it. */
let queue: Map<string, Waiter[]> | null = null

/**
 * BS-140: one work's status, delivered together with every other status asked for in the same tick.
 *
 * Only a transport: each caller is a query function of its own canonical key, so the answers land in
 * those keys and nowhere else — there is no second cache of statuses here. A shelf of cards that
 * mount in one commit becomes one `GET /me/reading-statuses?workIds=…` (one per 100 works) instead of
 * one request per card; a lone page asks the single-work route as before.
 *
 * A caller that is cancelled simply stops listening: the shared request is not aborted, so the rest
 * of the batch still gets its answers.
 */
export function loadReadingStatus(workId: string): Promise<ReadingStatusResponse> {
  return new Promise((resolve, reject) => {
    if (queue === null) {
      queue = new Map()
      // A promise job, not `queueMicrotask`: fake timers replace the latter, and a test with them
      // would then never flush.
      void Promise.resolve().then(flush)
    }

    const waiters = queue.get(workId) ?? []

    waiters.push({ resolve, reject })
    queue.set(workId, waiters)
  })
}

function flush(): void {
  const batch = queue

  queue = null

  if (batch === null) return

  const workIds = [...batch.keys()]
  const [only] = workIds

  if (workIds.length === 1 && only !== undefined) {
    settle(batch, workIds, fetchReadingStatus(only).then(singleAnswer))

    return
  }

  for (let start = 0; start < workIds.length; start += READING_STATUS_BATCH_LIMITS.idsMax) {
    const chunk = workIds.slice(start, start + READING_STATUS_BATCH_LIMITS.idsMax)

    settle(batch, chunk, fetchReadingStatuses(chunk).then(batchAnswer))
  }
}

type Answers = (workId: string) => ReadingStatusResponse | undefined

function singleAnswer(response: ReadingStatusResponse): Answers {
  return () => response
}

function batchAnswer({ items }: ReadingStatusesResponse): Answers {
  const byRequested = new Map(
    items.map(({ requestedWorkId, ...status }) => [requestedWorkId, status]),
  )

  return (workId) => byRequested.get(workId)
}

function settle(batch: Map<string, Waiter[]>, workIds: string[], answers: Promise<Answers>): void {
  answers.then(
    (answerFor) => {
      for (const workId of workIds) {
        const answer = answerFor(workId)

        for (const waiter of batch.get(workId) ?? []) {
          // The batch leaves out a work that does not exist — the same answer the single route gives.
          if (answer === undefined) waiter.reject(workNotFound())
          else waiter.resolve(answer)
        }
      }
    },
    (error: unknown) => {
      for (const workId of workIds) {
        for (const waiter of batch.get(workId) ?? []) waiter.reject(error)
      }
    },
  )
}

function workNotFound(): ApiRequestError {
  return new ApiRequestError(404, { code: API_ERROR_CODES.NOT_FOUND, message: 'Твір не знайдено' })
}
