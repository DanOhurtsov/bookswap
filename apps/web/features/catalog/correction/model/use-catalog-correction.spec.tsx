/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@/app/lib/test-query-client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { WorkReloadOutcome } from '@/app/lib/use-catalog'
import { useCatalogCorrection } from './use-catalog-correction'

/**
 * §3.9/R12: the concurrency rules shared by all three correction forms, tested
 * once here instead of three times per entity form. Session-identity guard
 * behavior itself (§8e-3 follow-up) is covered separately, below.
 */

let mockSessionState: { status: 'authenticated'; user: { id: string } } | { status: 'guest' } = {
  status: 'authenticated',
  user: { id: 'me' },
}

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: mockSessionState, reload: jest.fn(), setUser: jest.fn() }),
}))

interface Entity {
  title: string
  revision: number
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

/**
 * One `QueryClient` per test, not per render: `wrapper` itself re-renders
 * whenever `act()` flushes a state update from inside the hook, and a
 * `QueryClient` created fresh on every one of those renders would reset
 * `useMutation`'s own observer state (`isPending` included) along with it.
 */
function createWrapper() {
  const client = createTestQueryClient()

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function successReload(): Promise<WorkReloadOutcome> {
  return Promise.resolve({ status: 'success' })
}

function useTestCorrection(overrides: {
  mutationFn: (body: Entity) => Promise<Entity>
  reload: () => Promise<WorkReloadOutcome>
  entityId?: string
}) {
  const { entityId = 'entity-1', ...rest } = overrides

  return useCatalogCorrection<Entity, Entity>({
    mutationKey: ['test'],
    revisionOf: (entity) => entity.revision,
    entityId,
    ...rest,
  })
}

beforeEach(() => {
  mockSessionState = { status: 'authenticated', user: { id: 'me' } }
})

it('успішний submit переводить overlay у confirmed і викликає reload', async () => {
  const reload = jest.fn(successReload)
  const { result } = renderHook(
    () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
    { wrapper: createWrapper() },
  )

  act(() => {
    result.current.submit({ title: 'Нова', revision: 1 }, { title: 'Нова', revision: 1 })
  })

  expect(result.current.overlay).toEqual({
    phase: 'optimistic',
    entity: { title: 'Нова', revision: 1 },
  })

  await waitFor(() => {
    expect(result.current.overlay).toEqual({
      phase: 'confirmed',
      entity: { title: 'Нова', revision: 1 },
    })
  })
  expect(reload).toHaveBeenCalledTimes(1)
})

/**
 * §3.9's "a stale error must not roll back a later success" rule is guarded
 * by `token` in `onError` (see the hook) — but reaching that race through the
 * public `submit()` would require two overlapping calls, which the
 * double-submit guard below now refuses at the source. The token check stays
 * as defense in depth (nothing else currently calls `mutation.mutate`
 * directly); this is why there is no scenario left here that overlaps two
 * `submit()` calls the way an earlier version of this test did.
 */
it('невдалий submit не чіпає overlay, підтверджений попереднім успішним submit', async () => {
  const reload = jest.fn(successReload)
  let shouldFail = false

  const { result } = renderHook(
    () =>
      useTestCorrection({
        mutationFn: () =>
          shouldFail
            ? Promise.reject(new Error('відмовлено'))
            : Promise.resolve({ title: 'Перша', revision: 2 }),
        reload,
      }),
    { wrapper: createWrapper() },
  )

  await act(async () => {
    result.current.submit({ title: 'Перша', revision: 2 }, { title: 'Перша', revision: 2 })
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(result.current.overlay).toEqual({
      phase: 'confirmed',
      entity: { title: 'Перша', revision: 2 },
    })
  })

  shouldFail = true

  await act(async () => {
    result.current.submit(
      { title: 'Друга (провалиться)', revision: 2 },
      { title: 'Друга (провалиться)', revision: 2 },
    )
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(result.current.saveError).toBeInstanceOf(Error)
  })
  // Rolled back to what the FIRST submit confirmed — not wiped to `undefined`.
  expect(result.current.overlay).toEqual({
    phase: 'confirmed',
    entity: { title: 'Перша', revision: 2 },
  })
})

it('помилка reload після успішного PATCH стає refreshNotice, а не saveError', async () => {
  const reload = jest.fn(() =>
    Promise.resolve<WorkReloadOutcome>({ status: 'error', message: 'мережа лягла' }),
  )

  const { result } = renderHook(
    () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
    { wrapper: createWrapper() },
  )

  act(() => {
    result.current.submit({ title: 'Нова', revision: 1 }, { title: 'Нова', revision: 1 })
  })

  await waitFor(() => {
    expect(result.current.refreshNotice).toBe('мережа лягла')
  })

  expect(result.current.saveError).toBeUndefined()
  expect(result.current.overlay).toEqual({
    phase: 'confirmed',
    entity: { title: 'Нова', revision: 1 },
  })
})

it('невдалий submit відкочує overlay до попереднього значення', async () => {
  const reload = jest.fn(successReload)

  const { result } = renderHook(
    () => useTestCorrection({ mutationFn: () => Promise.reject(new Error('відмовлено')), reload }),
    { wrapper: createWrapper() },
  )

  await act(async () => {
    result.current.submit({ title: 'Не пройде', revision: 1 }, { title: 'Не пройде', revision: 1 })
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(result.current.saveError).toBeInstanceOf(Error)
  })
  expect(result.current.overlay).toBeUndefined()
})

it('submit під час pending не викликає другий mutationFn (подвійний клік)', async () => {
  const pending = defer<Entity>()
  const mutationFn = jest.fn(() => pending.promise)
  const reload = jest.fn(successReload)

  const { result } = renderHook(() => useTestCorrection({ mutationFn, reload }), {
    wrapper: createWrapper(),
  })

  act(() => {
    result.current.submit({ title: 'A', revision: 1 }, { title: 'A', revision: 1 })
  })
  act(() => {
    // A second call while the first is still pending — must be a no-op.
    result.current.submit({ title: 'B', revision: 1 }, { title: 'B', revision: 1 })
  })

  await waitFor(() => {
    expect(mutationFn).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    pending.resolve({ title: 'A', revision: 2 })
    await Promise.resolve()
  })

  // Still just the one call, now that the mutation has settled too.
  expect(mutationFn).toHaveBeenCalledTimes(1)
})

it(
  'два submit() в ОДНОМУ render batch — теж лише один mutationFn ' +
    '(mutation.isPending з попереднього render цього не гарантує)',
  async () => {
    const pending = defer<Entity>()
    const mutationFn = jest.fn(() => pending.promise)
    const reload = jest.fn(successReload)

    const { result } = renderHook(() => useTestCorrection({ mutationFn, reload }), {
      wrapper: createWrapper(),
    })

    // Both calls happen synchronously, in the SAME act callback — no render
    // (and so no update to `mutation.isPending`) happens in between them.
    act(() => {
      result.current.submit({ title: 'A', revision: 1 }, { title: 'A', revision: 1 })
      result.current.submit({ title: 'B', revision: 1 }, { title: 'B', revision: 1 })
    })

    await waitFor(() => {
      expect(mutationFn).toHaveBeenCalledTimes(1)
    })
    expect(mutationFn).toHaveBeenCalledWith({ title: 'A', revision: 1 })

    await act(async () => {
      pending.resolve({ title: 'A', revision: 2 })
      await Promise.resolve()
    })

    expect(mutationFn).toHaveBeenCalledTimes(1)
  },
)

describe('resolve()', () => {
  it(
    'pending PATCH (optimistic): РІВНА revision у свіжому знімку не підтверджує ' +
      'операцію — overlay лишається',
    async () => {
      const pending = defer<Entity>()
      const reload = jest.fn(successReload)
      const { result } = renderHook(
        () => useTestCorrection({ mutationFn: () => pending.promise, reload }),
        { wrapper: createWrapper() },
      )

      act(() => {
        // The optimistic guess carries the SAME revision the entity already
        // has — the PATCH hasn't answered yet, so there is no new one to know.
        result.current.submit(
          { title: 'В процесі', revision: 3 },
          { title: 'В процесі', revision: 3 },
        )
      })

      await waitFor(() => {
        expect(result.current.overlay?.phase).toBe('optimistic')
      })

      // A fresh snapshot at that SAME revision must not be mistaken for
      // "already confirmed" — nothing server-side has changed yet.
      expect(result.current.resolve({ title: 'До редагування', revision: 3 })).toEqual({
        title: 'В процесі',
        revision: 3,
      })
      expect(result.current.overlay?.phase).toBe('optimistic')

      await act(async () => {
        pending.resolve({ title: 'В процесі', revision: 4 })
        await Promise.resolve()
      })
    },
  )

  it('без overlay повертає свіжий знімок як є', () => {
    const { result } = renderHook(
      () =>
        useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload: successReload }),
      { wrapper: createWrapper() },
    )

    expect(result.current.resolve({ title: 'З сервера', revision: 3 })).toEqual({
      title: 'З сервера',
      revision: 3,
    })
  })

  it('overlay попереду свіжого знімку — показує overlay, не старіші дані', async () => {
    const reload = jest.fn(successReload)
    const { result } = renderHook(
      () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'Підтверджено', revision: 5 },
        { title: 'Підтверджено', revision: 5 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('confirmed')
    })

    // A GET that hasn't caught up yet (still at revision 4) must not shadow
    // the confirmed PATCH — this is what keeps the new value on screen
    // through a failed/slow refresh, and after the form that made it closes.
    expect(result.current.resolve({ title: 'Застаріла', revision: 4 })).toEqual({
      title: 'Підтверджено',
      revision: 5,
    })
  })

  it('свіжий знімок наздогнав overlay — показує знімок і очищає overlay', async () => {
    const reload = jest.fn(successReload)
    const { result } = renderHook(
      () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'Підтверджено', revision: 5 },
        { title: 'Підтверджено', revision: 5 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('confirmed')
    })

    let shown: Entity | undefined

    act(() => {
      shown = result.current.resolve({ title: 'Підтверджено', revision: 5 })
    })

    expect(shown).toEqual({ title: 'Підтверджено', revision: 5 })
    expect(result.current.overlay).toBeUndefined()
  })

  it('хтось інший змінив сутність далі — свіжий знімок переважає overlay', async () => {
    const reload = jest.fn(successReload)
    const { result } = renderHook(
      () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'Моя зміна', revision: 5 },
        { title: 'Моя зміна', revision: 5 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('confirmed')
    })

    let shown: Entity | undefined

    act(() => {
      shown = result.current.resolve({ title: 'Чужа новіша зміна', revision: 6 })
    })

    expect(shown).toEqual({ title: 'Чужа новіша зміна', revision: 6 })
    expect(result.current.overlay).toBeUndefined()
  })
})

describe('зміна сесії (§8e-3 follow-up)', () => {
  it('logout/login під іншим акаунтом очищає overlay і refreshNotice цього екземпляра', async () => {
    const reload = jest.fn(successReload)
    const { result, rerender } = renderHook(
      () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'Підтверджено', revision: 2 },
        { title: 'Підтверджено', revision: 2 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('confirmed')
    })

    mockSessionState = { status: 'authenticated', user: { id: 'someone-else' } }
    rerender()

    await waitFor(() => {
      expect(result.current.overlay).toBeUndefined()
    })
  })

  it('пізній callback від PATCH, розпочатого попередньою сесією, не застосовується', async () => {
    const inFlight = defer<Entity>()
    const reload = jest.fn(successReload)

    const { result, rerender } = renderHook(
      () => useTestCorrection({ mutationFn: () => inFlight.promise, reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'В польоті', revision: 1 },
        { title: 'В польоті', revision: 1 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('optimistic')
    })

    // Someone logs out / a different person logs in while the PATCH from the
    // PREVIOUS identity is still in flight.
    mockSessionState = { status: 'guest' }
    rerender()

    await waitFor(() => {
      expect(result.current.overlay).toBeUndefined()
    })

    await act(async () => {
      inFlight.resolve({ title: 'В польоті', revision: 2 })
      await Promise.resolve()
    })

    // The late success must not resurrect the previous session's overlay.
    expect(result.current.overlay).toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
  })

  it('зміна сесії скидає saveError — TanStack-стан mutation, не лише overlay/confirmed', async () => {
    const reload = jest.fn(successReload)
    const { result, rerender } = renderHook(
      () =>
        useTestCorrection({ mutationFn: () => Promise.reject(new Error('відмовлено')), reload }),
      { wrapper: createWrapper() },
    )

    await act(async () => {
      result.current.submit(
        { title: 'Не пройде', revision: 1 },
        { title: 'Не пройде', revision: 1 },
      )
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.saveError).toBeInstanceOf(Error)
    })

    mockSessionState = { status: 'authenticated', user: { id: 'someone-else' } }
    rerender()

    // `saveError` reads straight off `mutation.status`/`.error` — clearing
    // `overlay`/`confirmed` alone does not touch that TanStack-owned state.
    await waitFor(() => {
      expect(result.current.saveError).toBeUndefined()
    })
  })

  it('зміна entityId скидає justSaved — інакше нова сутність виглядає вже збереженою', async () => {
    const reload = jest.fn(successReload)
    const { result, rerender } = renderHook(
      ({ entityId }: { entityId: string }) =>
        useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload, entityId }),
      { wrapper: createWrapper(), initialProps: { entityId: 'work-a' } },
    )

    act(() => {
      result.current.submit({ title: 'Книга А', revision: 2 }, { title: 'Книга А', revision: 2 })
    })

    await waitFor(() => {
      expect(result.current.justSaved).toBe(true)
    })

    rerender({ entityId: 'work-b' })

    await waitFor(() => {
      expect(result.current.justSaved).toBe(false)
    })
  })
})

describe('confirmed (baseline sync independent of overlay/resolve())', () => {
  it('confirmed лишається доступним, навіть якщо resolve() уже прибрав overlay', async () => {
    const reload = jest.fn(successReload)
    const { result } = renderHook(
      () => useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload }),
      { wrapper: createWrapper() },
    )

    act(() => {
      result.current.submit(
        { title: 'Підтверджено', revision: 5 },
        { title: 'Підтверджено', revision: 5 },
      )
    })

    await waitFor(() => {
      expect(result.current.confirmed).toEqual({ title: 'Підтверджено', revision: 5 })
    })

    // A form's baseline-sync effect must not have to race `resolve()` for
    // this — simulate the ancestor already having reconciled the overlay
    // away (a fast GET catching up) in the SAME tick `confirmed` was set.
    act(() => {
      result.current.resolve({ title: 'Підтверджено', revision: 5 })
    })

    expect(result.current.overlay).toBeUndefined()
    expect(result.current.confirmed).toEqual({ title: 'Підтверджено', revision: 5 })
  })
})

describe('зміна ідентичності сутності (entityId, §8e-3 follow-up)', () => {
  it('зміна entityId скидає overlay/confirmed/refreshNotice цього екземпляра', async () => {
    const reload = jest.fn(successReload)
    const { result, rerender } = renderHook(
      ({ entityId }: { entityId: string }) =>
        useTestCorrection({ mutationFn: (body) => Promise.resolve(body), reload, entityId }),
      { wrapper: createWrapper(), initialProps: { entityId: 'work-a' } },
    )

    act(() => {
      result.current.submit({ title: 'Книга А', revision: 5 }, { title: 'Книга А', revision: 5 })
    })

    await waitFor(() => {
      expect(result.current.confirmed).toEqual({ title: 'Книга А', revision: 5 })
    })

    // Same component instance, now correcting a DIFFERENT entity — e.g.
    // `WorkPage` staying mounted across a client-side navigation to another
    // Work. A fresh, lower revision for the NEW entity must not be shadowed
    // by A's leftover confirmed overlay.
    rerender({ entityId: 'work-b' })

    await waitFor(() => {
      expect(result.current.overlay).toBeUndefined()
    })
    expect(result.current.confirmed).toBeUndefined()
    expect(result.current.resolve({ title: 'Книга Б', revision: 1 })).toEqual({
      title: 'Книга Б',
      revision: 1,
    })
  })

  it('пізня відповідь операції, розпочатої для ПОПЕРЕДНЬОЇ сутності, ігнорується', async () => {
    const inFlight = defer<Entity>()
    const reload = jest.fn(successReload)

    const { result, rerender } = renderHook(
      ({ entityId }: { entityId: string }) =>
        useTestCorrection({ mutationFn: () => inFlight.promise, reload, entityId }),
      { wrapper: createWrapper(), initialProps: { entityId: 'work-a' } },
    )

    act(() => {
      result.current.submit(
        { title: 'В польоті для А', revision: 1 },
        { title: 'В польоті для А', revision: 1 },
      )
    })

    await waitFor(() => {
      expect(result.current.overlay?.phase).toBe('optimistic')
    })

    // Navigated to a different entity while A's PATCH is still in flight.
    rerender({ entityId: 'work-b' })

    await waitFor(() => {
      expect(result.current.overlay).toBeUndefined()
    })

    await act(async () => {
      inFlight.resolve({ title: 'В польоті для А', revision: 2 })
      await Promise.resolve()
    })

    // A's late success must not resurrect an overlay under B's identity.
    expect(result.current.overlay).toBeUndefined()
    expect(result.current.confirmed).toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
  })
})
