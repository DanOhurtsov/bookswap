/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient } from '@/app/lib/test-query-client'
import { readingStatusQueryKey, useReadingStatus } from './use-reading-status'

/**
 * BS-140: one cache entry per user and work, shared by every control of the work. Only `apiRequest`
 * is mocked; the batching transport and TanStack Query are real.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const BATCH = '/me/reading-statuses?workIds='

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

/** The server's rows; a missing work has no row. */
let rows: Map<string, ReadingStatus>
/** Merged works: source id → canonical id. A read follows it; a save by the source id is refused. */
let merged: Map<string, string>
/** When set, the next reads wait for the test instead of answering at once. */
let holdReads: { release: () => void; promise: Promise<void> } | null

function answer(requested: string) {
  const workId = merged.get(requested) ?? requested
  const status = rows.get(workId)

  return { workId, status: status ?? 'NOT_READ', isSet: status !== undefined, wasBorrowed: false }
}

function hold(): () => void {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })

  holdReads = { release, promise }

  return release
}

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    const single = /^\/me\/reading-statuses\/([^?]+)$/.exec(path)?.[1]

    if (options.method === 'PUT' && single !== undefined && options.body !== undefined) {
      const canonicalWorkId = merged.get(single)

      if (canonicalWorkId !== undefined) {
        return Promise.reject(
          new ApiRequestError(409, {
            code: 'WORK_MERGED',
            message: 'Твір обʼєднано з іншим',
            details: { canonicalWorkId },
          }),
        )
      }

      rows.set(single, options.body.status)

      return Promise.resolve({ workId: single, status: options.body.status })
    }

    // The answer is what the server held WHEN the read was sent, even if it lands later.
    const ids = path.startsWith(BATCH)
      ? path.slice(BATCH.length).split(',')
      : single
        ? [single]
        : []
    const snapshot = path.startsWith(BATCH)
      ? { items: ids.map((id) => ({ requestedWorkId: id, ...answer(id) })) }
      : answer(ids[0] ?? '')
    const gate = holdReads?.promise ?? Promise.resolve()

    if (ids.length === 0) return Promise.reject(new Error(`unexpected ${path}`))

    return gate.then(() => snapshot)
  })
}

function sent(): string[] {
  return apiRequest.mock.calls.map(
    ([path, options]: [string, RequestOptions | undefined]) =>
      `${options?.method ?? 'GET'} ${path}`,
  )
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/** Two controls of `w-1` (two edition cards of one work) and one of `w-2`, in one client. */
function renderShelf(client = createTestQueryClient()) {
  const rendered = renderHook(
    () => ({
      first: useReadingStatus({ userId: 'me', workId: 'w-1' }),
      second: useReadingStatus({ userId: 'me', workId: 'w-1' }),
      other: useReadingStatus({ userId: 'me', workId: 'w-2' }),
    }),
    { wrapper: wrapperFor(client) },
  )

  return { ...rendered, client }
}

function current(view: ReturnType<typeof useReadingStatus>['view']): ReadingStatus | null | 'n/a' {
  return view.kind === 'ready' ? view.current : 'n/a'
}

/** Every read has settled — dropped or written — so a stale answer has had its chance to land. */
async function settled(client: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(client.isFetching()).toBe(0)
  })
}

async function ready(result: { current: ReturnType<typeof renderShelf>['result']['current'] }) {
  await waitFor(() => {
    expect(result.current.first.view.kind).toBe('ready')
    expect(result.current.other.view.kind).toBe('ready')
  })
}

beforeEach(() => {
  apiRequest.mockReset()
  rows = new Map()
  merged = new Map()
  holdReads = null
  serve()
})

describe('useReadingStatus (BS-140)', () => {
  it('controls of one work read one entry: one batch, and a save shows in every control of the work', async () => {
    const { result } = renderShelf()

    await ready(result)
    expect(sent()).toEqual([`GET ${BATCH}w-1,w-2`])
    expect(current(result.current.first.view)).toBeNull()

    act(() => {
      result.current.first.save('READ')
    })

    await waitFor(() => {
      expect(current(result.current.second.view)).toBe('READ')
    })
    expect(current(result.current.first.view)).toBe('READ')
    expect(current(result.current.other.view)).toBeNull()
    // The save wrote the cache; nothing was read again to learn it.
    expect(sent()).toEqual([`GET ${BATCH}w-1,w-2`, 'PUT /me/reading-statuses/w-1'])
  })

  it('choosing NOT_READ with nothing set is a save; choosing the current status is not', async () => {
    rows.set('w-2', 'READING')

    const { result } = renderShelf()

    await ready(result)

    act(() => {
      result.current.other.save('READING')
      result.current.first.save('NOT_READ')
    })

    await waitFor(() => {
      expect(current(result.current.first.view)).toBe('NOT_READ')
    })
    expect(sent().filter((request) => request.startsWith('PUT'))).toEqual([
      'PUT /me/reading-statuses/w-1',
    ])
  })

  it('while a save is in flight every control of the work is locked and a second save is dropped', async () => {
    const { result } = renderShelf()

    await ready(result)

    let finish: (value: unknown) => void = () => undefined

    apiRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    act(() => {
      result.current.first.save('READ')
      // Same tick, another control of the same work: the mutation cache already says «pending».
      result.current.second.save('READING')
    })

    await waitFor(() => {
      expect(result.current.second.view).toMatchObject({ kind: 'ready', saving: 'READ' })
    })
    expect(result.current.first.view).toMatchObject({ saving: 'READ' })
    expect(result.current.other.view).toMatchObject({ saving: undefined })

    act(() => {
      result.current.second.save('READING')
    })

    await act(async () => {
      finish({ workId: 'w-1', status: 'READ' })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.second.view).toMatchObject({ current: 'READ', saving: undefined })
    })
    expect(sent().filter((request) => request.startsWith('PUT'))).toHaveLength(1)
  })

  it('a single read that started before the save and lands after it does not put the old status back', async () => {
    const client = createTestQueryClient()
    const { result } = renderHook(() => useReadingStatus({ userId: 'me', workId: 'w-1' }), {
      wrapper: wrapperFor(client),
    })

    await waitFor(() => {
      expect(result.current.view.kind).toBe('ready')
    })

    const release = hold()

    act(() => {
      result.current.retryLoad()
    })
    await waitFor(() => {
      expect(sent()).toHaveLength(2)
    })

    act(() => {
      result.current.save('READ')
    })
    await waitFor(() => {
      expect(result.current.view).toMatchObject({ current: 'READ' })
    })

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settled(client)

    expect(result.current.view).toMatchObject({ current: 'READ' })
    expect(client.getQueryData(readingStatusQueryKey('me', 'w-1'))).toMatchObject({
      status: 'READ',
      isSet: true,
    })
  })

  it('a late batch drops only the saved work: the rest of the batch still gets its answer', async () => {
    const { result, client } = renderShelf()

    await ready(result)

    const release = hold()

    rows.set('w-2', 'READING')
    act(() => {
      void client.invalidateQueries({ queryKey: ['reading-status', 'me'] })
    })
    await waitFor(() => {
      expect(sent()).toEqual([`GET ${BATCH}w-1,w-2`, `GET ${BATCH}w-1,w-2`])
    })

    // The batch was sent before this save; its w-1 is the old «not set».
    act(() => {
      result.current.first.save('READ')
    })
    await waitFor(() => {
      expect(current(result.current.first.view)).toBe('READ')
    })

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settled(client)

    expect(current(result.current.other.view)).toBe('READING')
    expect(current(result.current.first.view)).toBe('READ')
    expect(current(result.current.second.view)).toBe('READ')
  })

  it('a read that starts while the save is in flight and lands after it is dropped too', async () => {
    const { result, client } = renderShelf()

    await ready(result)

    let finish: (value: unknown) => void = () => undefined

    apiRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    act(() => {
      result.current.first.save('READ')
    })
    await waitFor(() => {
      expect(result.current.first.view).toMatchObject({ saving: 'READ' })
    })

    // Sent before the PUT is committed: it reads «not set».
    const release = hold()

    act(() => {
      void client.refetchQueries({ queryKey: readingStatusQueryKey('me', 'w-1') })
    })
    await waitFor(() => {
      expect(sent().at(-1)).toBe('GET /me/reading-statuses/w-1')
    })

    rows.set('w-1', 'READ')
    await act(async () => {
      finish({ workId: 'w-1', status: 'READ' })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(current(result.current.first.view)).toBe('READ')
    })

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settled(client)

    expect(current(result.current.first.view)).toBe('READ')
    expect(current(result.current.second.view)).toBe('READ')
  })

  it('a failed save keeps the confirmed status, is not retried on its own, and a retry re-sends it', async () => {
    rows.set('w-1', 'READING')

    const { result } = renderShelf()

    await ready(result)

    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )
    act(() => {
      result.current.first.save('READ')
    })

    await waitFor(() => {
      expect(result.current.first.view).toMatchObject({ failed: 'READ', current: 'READING' })
    })
    // Only the control where it failed reports it; the other one still shows the confirmed status.
    expect(result.current.second.view).toMatchObject({
      current: 'READING',
      failed: undefined,
      saving: undefined,
    })
    expect(sent().filter((request) => request.startsWith('PUT'))).toHaveLength(1)

    act(() => {
      result.current.first.retrySave()
    })

    await waitFor(() => {
      expect(result.current.second.view).toMatchObject({ current: 'READ' })
    })
    expect(result.current.first.view).toMatchObject({ saved: 'READ', failed: undefined })
    expect(sent().filter((request) => request.startsWith('PUT'))).toHaveLength(2)
  })

  it('a failed read is an error; the retry reads again', async () => {
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Немає звʼязку' }),
    )

    const { result } = renderHook(() => useReadingStatus({ userId: 'me', workId: 'w-1' }), {
      wrapper: wrapperFor(createTestQueryClient()),
    })

    await waitFor(() => {
      expect(result.current.view).toEqual({ kind: 'error', message: 'Немає звʼязку' })
    })

    act(() => {
      result.current.retryLoad()
    })

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'ready', current: null })
    })
  })

  it('the same work of another user is another entry: a save by one never shows for the other', async () => {
    const client = createTestQueryClient()
    const { result } = renderHook(
      () => ({
        mine: useReadingStatus({ userId: 'a', workId: 'w-1' }),
        theirs: useReadingStatus({ userId: 'b', workId: 'w-1' }),
      }),
      { wrapper: wrapperFor(client) },
    )

    await waitFor(() => {
      expect(result.current.theirs.view.kind).toBe('ready')
    })

    act(() => {
      result.current.mine.save('READ')
    })
    await waitFor(() => {
      expect(current(result.current.mine.view)).toBe('READ')
    })

    expect(current(result.current.theirs.view)).toBeNull()
    expect(result.current.theirs.view).toMatchObject({ saving: undefined, saved: undefined })
  })

  describe('a work merged while its controls are on screen', () => {
    /**
     * Two cards of `w-a` and one of `w-b`, both READING; then `w-a` is merged into `w-b` and every
     * status is read again with the shelf still open — the batch now answers `w-a` as `w-b`.
     */
    async function renderMerged() {
      rows.set('w-a', 'READING')
      rows.set('w-b', 'READING')

      const client = createTestQueryClient()
      const rendered = renderHook(
        () => ({
          a1: useReadingStatus({ userId: 'me', workId: 'w-a' }),
          a2: useReadingStatus({ userId: 'me', workId: 'w-a' }),
          b: useReadingStatus({ userId: 'me', workId: 'w-b' }),
        }),
        { wrapper: wrapperFor(client) },
      )

      await waitFor(() => {
        expect(rendered.result.current.a1.view.kind).toBe('ready')
        expect(rendered.result.current.b.view.kind).toBe('ready')
      })

      merged.set('w-a', 'w-b')
      rows.delete('w-a')
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['reading-status', 'me'] })
      })
      await settled(client)
      expect(sent().at(-1)).toBe(`GET ${BATCH}w-a,w-b`)

      return { ...rendered, client }
    }

    function puts(): string[] {
      return sent().filter((request) => request.startsWith('PUT'))
    }

    it('once a read names the canonical work, a save from either side shows in every control', async () => {
      const { result, client } = await renderMerged()

      act(() => {
        result.current.b.save('READ')
      })
      await waitFor(() => {
        expect(current(result.current.a1.view)).toBe('READ')
      })
      expect(current(result.current.a2.view)).toBe('READ')
      expect(current(result.current.b.view)).toBe('READ')

      // The merged work's card saves by the id it already knows to be canonical.
      act(() => {
        result.current.a2.save('NOT_READ')
      })
      await waitFor(() => {
        expect(current(result.current.b.view)).toBe('NOT_READ')
      })
      expect(current(result.current.a1.view)).toBe('NOT_READ')
      expect(puts()).toEqual(['PUT /me/reading-statuses/w-b', 'PUT /me/reading-statuses/w-b'])
      expect(client.getQueryData(readingStatusQueryKey('me', 'w-b'))).toMatchObject({
        status: 'NOT_READ',
      })
    })

    it('a save in flight locks the merged and the canonical controls alike; a second save is not sent', async () => {
      const { result } = await renderMerged()

      let finish: (value: unknown) => void = () => undefined

      apiRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      act(() => {
        result.current.a1.save('READ')
      })
      await waitFor(() => {
        expect(result.current.b.view).toMatchObject({ kind: 'ready', saving: 'READ' })
      })
      expect(result.current.a2.view).toMatchObject({ saving: 'READ' })

      act(() => {
        result.current.b.save('NOT_READ')
        result.current.a2.save('NOT_READ')
      })

      await act(async () => {
        finish({ workId: 'w-b', status: 'READ' })
        await Promise.resolve()
      })
      await waitFor(() => {
        expect(result.current.b.view).toMatchObject({ current: 'READ', saving: undefined })
      })
      expect(puts()).toEqual(['PUT /me/reading-statuses/w-b'])
    })

    it('a batch sent before the save and answered after it does not roll the save back', async () => {
      const { result, client } = await renderMerged()
      const release = hold()

      act(() => {
        void client.invalidateQueries({ queryKey: ['reading-status', 'me'] })
      })
      await waitFor(() => {
        expect(sent().at(-1)).toBe(`GET ${BATCH}w-a,w-b`)
      })

      act(() => {
        result.current.a1.save('READ')
      })
      await waitFor(() => {
        expect(current(result.current.b.view)).toBe('READ')
      })

      // The held batch still carries READING for both ids.
      await act(async () => {
        release()
        await Promise.resolve()
      })
      await settled(client)

      expect(current(result.current.a1.view)).toBe('READ')
      expect(current(result.current.a2.view)).toBe('READ')
      expect(current(result.current.b.view)).toBe('READ')
    })

    it('before any read names the canonical work, a save by the old id fails with 409 and is not redirected or repeated', async () => {
      rows.set('w-a', 'READING')

      const { result } = renderHook(() => useReadingStatus({ userId: 'me', workId: 'w-a' }), {
        wrapper: wrapperFor(createTestQueryClient()),
      })

      await waitFor(() => {
        expect(result.current.view.kind).toBe('ready')
      })

      merged.set('w-a', 'w-b')
      act(() => {
        result.current.save('READ')
      })

      await waitFor(() => {
        expect(result.current.view).toMatchObject({ failed: 'READ', current: 'READING' })
      })
      expect(result.current.view.kind === 'ready' && result.current.view.saveError).toMatchObject({
        code: 'WORK_MERGED',
      })
      expect(puts()).toEqual(['PUT /me/reading-statuses/w-a'])
    })
  })
})
