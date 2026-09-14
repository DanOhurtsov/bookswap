/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { WorkDetailResponse } from '@bookswap/shared'
import { ApiRequestError } from './api'
import { useWork, type WorkReloadOutcome } from './use-catalog'

/**
 * R12 (`docs/plan/stage-8-inventory.md`): `useWork().reload()` must resolve to
 * one of three distinct outcomes for exactly the request it caused — never
 * inferred from whether `revision` happened to change, and never adopted from
 * whichever request replaces it.
 */

jest.mock('./api', () => {
  const actual = jest.requireActual<typeof import('./api')>('./api')

  return { ...actual, apiRequestWithRedirect: jest.fn() }
})

const { apiRequestWithRedirect: mockLoad } = jest.requireMock<{
  apiRequestWithRedirect: jest.Mock
}>('./api')

function detail(title: string): WorkDetailResponse {
  return {
    work: {
      id: 'work-1',
      title,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
    translations: [],
    editions: [],
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  mockLoad.mockReset()
})

it('початкове завантаження виставляє ready і не чіпає reload-чергу', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Перше'), redirected: false })

  const { result } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state).toEqual({ status: 'ready', detail: detail('Перше') })
  })
})

it('успішний reload() резолвиться success і state показує свіжий знімок', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

  const { result } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state.status).toBe('ready')
  })

  const next = defer<{ data: WorkDetailResponse; redirected: boolean }>()

  mockLoad.mockReturnValueOnce(next.promise)

  let outcome: WorkReloadOutcome | undefined

  act(() => {
    void result.current.reload().then((value) => {
      outcome = value
    })
  })

  next.resolve({ data: detail('Нова'), redirected: false })

  await waitFor(() => {
    expect(outcome).toEqual({ status: 'success' })
  })
  expect(result.current.state).toEqual({ status: 'ready', detail: detail('Нова') })
})

it('reload() після мережевої помилки резолвиться error, не success', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

  const { result } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state.status).toBe('ready')
  })

  mockLoad.mockRejectedValueOnce(
    new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'бум' }),
  )

  let outcome: WorkReloadOutcome | undefined

  act(() => {
    void result.current.reload().then((value) => {
      outcome = value
    })
  })

  await waitFor(() => {
    expect(outcome).toEqual({ status: 'error', message: 'бум' })
  })
  // Помилка refresh не повинна стирати останній відомий успішний знімок.
  expect(result.current.state).toEqual({ status: 'ready', detail: detail('Стара') })
})

it(
  'reload(), випереджений другим reload() до завершення свого запиту, ' +
    'резолвиться cancelled — і не переписує стан даними, відповідними другому виклику',
  async () => {
    mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

    const { result } = renderHook(() => useWork('work-1'))

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready')
    })

    const first = defer<{ data: WorkDetailResponse; redirected: boolean }>()
    const second = defer<{ data: WorkDetailResponse; redirected: boolean }>()

    mockLoad.mockReturnValueOnce(first.promise)
    mockLoad.mockReturnValueOnce(second.promise)

    let firstOutcome: WorkReloadOutcome | undefined
    let secondOutcome: WorkReloadOutcome | undefined

    act(() => {
      void result.current.reload().then((value) => {
        firstOutcome = value
      })
    })

    act(() => {
      void result.current.reload().then((value) => {
        secondOutcome = value
      })
    })

    // Перший запит таки долітає — але вже після того, як другий його випередив.
    first.resolve({ data: detail('Застаріла відповідь'), redirected: false })

    await waitFor(() => {
      expect(firstOutcome).toEqual({ status: 'cancelled' })
    })

    // Другий ще летить: cancelled першого не мало бути видано завчасно як success/error.
    expect(secondOutcome).toBeUndefined()
    expect(result.current.state.status).toBe('ready')

    second.resolve({ data: detail('Свіжа'), redirected: false })

    await waitFor(() => {
      expect(secondOutcome).toEqual({ status: 'success' })
    })
    expect(result.current.state).toEqual({ status: 'ready', detail: detail('Свіжа') })
  },
)

it('reload() під час unmount резолвиться cancelled, а не висить назавжди', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

  const { result, unmount } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state.status).toBe('ready')
  })

  const pending = defer<{ data: WorkDetailResponse; redirected: boolean }>()

  mockLoad.mockReturnValueOnce(pending.promise)

  let outcome: WorkReloadOutcome | undefined

  act(() => {
    void result.current.reload().then((value) => {
      outcome = value
    })
  })

  unmount()

  await waitFor(() => {
    expect(outcome).toEqual({ status: 'cancelled' })
  })
})

it('reload(), викликаний уже після unmount, одразу резолвиться cancelled', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

  const { result, unmount } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state.status).toBe('ready')
  })

  unmount()

  await expect(result.current.reload()).resolves.toEqual({ status: 'cancelled' })
})

it('два reload() в одному render batch — один запит, обидва success з тим самим знімком', async () => {
  mockLoad.mockResolvedValueOnce({ data: detail('Стара'), redirected: false })

  const { result } = renderHook(() => useWork('work-1'))

  await waitFor(() => {
    expect(result.current.state.status).toBe('ready')
  })

  mockLoad.mockResolvedValueOnce({ data: detail('Нова'), redirected: false })

  let firstOutcome: WorkReloadOutcome | undefined
  let secondOutcome: WorkReloadOutcome | undefined

  // Both calls happen synchronously in the same commit — React batches the
  // two `setNonce` updates into one, so this must be exactly one request,
  // not two, and both callers get the SAME (successful) outcome.
  act(() => {
    void result.current.reload().then((value) => {
      firstOutcome = value
    })
    void result.current.reload().then((value) => {
      secondOutcome = value
    })
  })

  await waitFor(() => {
    expect(firstOutcome).toEqual({ status: 'success' })
  })
  expect(secondOutcome).toEqual({ status: 'success' })
  // Initial load + exactly one reload — the second call did not cause a second request.
  expect(mockLoad).toHaveBeenCalledTimes(2)
  expect(result.current.state).toEqual({ status: 'ready', detail: detail('Нова') })
})

it(
  'зміна workId під час reload попередньої книги: старий виклик — cancelled, ' +
    'і жодної миті не показує дані попередньої книги',
  async () => {
    mockLoad.mockResolvedValueOnce({ data: detail('Книга А'), redirected: false })

    const { result, rerender } = renderHook(({ workId }) => useWork(workId), {
      initialProps: { workId: 'work-a' },
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ready', detail: detail('Книга А') })
    })

    const staleReloadForA = defer<{ data: WorkDetailResponse; redirected: boolean }>()

    mockLoad.mockReturnValueOnce(staleReloadForA.promise)

    let staleOutcome: WorkReloadOutcome | undefined

    act(() => {
      void result.current.reload().then((value) => {
        staleOutcome = value
      })
    })

    const forB = defer<{ data: WorkDetailResponse; redirected: boolean }>()

    mockLoad.mockReturnValueOnce(forB.promise)

    // Navigate to a different book while book A's reload is still in flight.
    rerender({ workId: 'work-b' })

    // Book A's data must not linger under book B's identity, even transiently.
    expect(result.current.state).toEqual({ status: 'loading' })

    await waitFor(() => {
      expect(staleOutcome).toEqual({ status: 'cancelled' })
    })
    expect(result.current.state).toEqual({ status: 'loading' })

    // Book A's own (stale) reload finally answers — must still not leak through.
    staleReloadForA.resolve({ data: detail('Книга А (застаріла відповідь)'), redirected: false })
    await Promise.resolve()
    expect(result.current.state).toEqual({ status: 'loading' })

    forB.resolve({ data: detail('Книга Б'), redirected: false })

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ready', detail: detail('Книга Б') })
    })
  },
)
