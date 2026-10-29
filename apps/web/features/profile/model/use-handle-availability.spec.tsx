/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { HANDLE_CHECK_DELAY_MS } from './handle-check'
import { useHandleAvailability } from './use-handle-availability'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function checked(): string[] {
  return apiRequest.mock.calls.map(([path]) => String(path))
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

function renderCheck(draft: string) {
  return renderHook(({ text }) => useHandleAvailability('user-1', 'marta', text), {
    initialProps: { text: draft },
    wrapper: ({ children }: { children: ReactNode }) => withQueryClient(<>{children}</>),
  })
}

/**
 * Lets the pause pass and the answer that follows it settle: React Query tells its observers on a
 * zero timer of its own, so the clock moves a little past the pause too.
 */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  apiRequest.mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('useHandleAvailability', () => {
  it('питає через паузу після останнього символу — лише про останній текст', async () => {
    apiRequest.mockResolvedValue({ available: true })
    const { result, rerender } = renderCheck('marta')

    rerender({ text: 'marta_r' })
    await pass(HANDLE_CHECK_DELAY_MS - 100)
    rerender({ text: 'marta_reads' })

    expect(result.current.message).toBe('Перевіряємо…')

    await pass(HANDLE_CHECK_DELAY_MS)

    expect(checked()).toEqual(['/users/handles/marta_reads/availability'])
    expect(result.current).toMatchObject({ message: '✓ Нік вільний', blocksSave: false })
  })

  it('свій нік, неправильний формат — без запиту', async () => {
    const { result, rerender } = renderCheck('marta')

    await pass(HANDLE_CHECK_DELAY_MS)
    expect(result.current.message).toBe('Це ваш поточний нік')

    rerender({ text: 'm-' })
    await pass(HANDLE_CHECK_DELAY_MS)

    expect(result.current).toMatchObject({ tone: 'error', blocksSave: true })
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('відповідь, що відстала, не стає відповіддю для нового тексту', async () => {
    const late = deferred<{ available: boolean }>()

    apiRequest.mockImplementation((path: string) =>
      path.includes('/taras/') ? late.promise : Promise.resolve({ available: true }),
    )
    const { result, rerender } = renderCheck('taras')

    await pass(HANDLE_CHECK_DELAY_MS)
    rerender({ text: 'taras_reads' })
    await pass(HANDLE_CHECK_DELAY_MS)

    expect(result.current.message).toBe('✓ Нік вільний')

    late.resolve({ available: false })
    await pass(0)

    expect(result.current.message).toBe('✓ Нік вільний')
  })

  it('збій перевірки блокує збереження; «Перевірити ще раз» питає знову', async () => {
    apiRequest
      .mockRejectedValueOnce(
        new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
      )
      .mockResolvedValueOnce({ available: true })
    const { result } = renderCheck('marta_reads')

    await pass(HANDLE_CHECK_DELAY_MS)

    expect(result.current).toMatchObject({
      message: 'Не вдалося перевірити нік',
      blocksSave: true,
      canRetry: true,
    })

    act(() => {
      result.current.retry()
    })
    await pass(0)

    expect(result.current).toMatchObject({ message: '✓ Нік вільний', blocksSave: false })
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })
})
