/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import { SEARCH_MAX_PAGE, type ExternalSearchResponse } from '@bookswap/shared'
import { searchExternalCatalogs } from '../api/search-external'
import { useExternalSearch } from './use-external-search'

jest.mock('../api/search-external', () => ({ searchExternalCatalogs: jest.fn() }))

const ask = searchExternalCatalogs as jest.MockedFunction<typeof searchExternalCatalogs>

function response(overrides: Partial<ExternalSearchResponse> = {}): ExternalSearchResponse {
  return {
    results: [],
    sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
    page: 1,
    pageSize: 10,
    more: 'NO',
    complete: true,
    ...overrides,
  }
}

beforeEach(() => {
  ask.mockReset()
})

describe('useExternalSearch', () => {
  it('питає q, page і pageSize', async () => {
    ask.mockResolvedValue(response({ page: 3, pageSize: 20 }))

    const { result } = renderHook(() => useExternalSearch('тигролови', 3, 20))

    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })
    expect(ask).toHaveBeenCalledWith('тигролови', 3, 20, expect.any(AbortSignal))
  })

  it('запит-ISBN не йде в пошук за назвою', () => {
    const { result } = renderHook(() => useExternalSearch('9786177585113', 1, 10))

    expect(result.current.status).toBe('idle')
    expect(ask).not.toHaveBeenCalled()
  })

  it('неповну сторінку довантажує тим самим запитом, поки не complete', async () => {
    ask
      .mockResolvedValueOnce(response({ complete: false, more: 'UNKNOWN' }))
      .mockResolvedValueOnce(response({ complete: false, more: 'UNKNOWN' }))
      .mockResolvedValueOnce(response({ complete: true, more: 'YES' }))

    const { result } = renderHook(() => useExternalSearch('тигролови', 3, 10))

    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', complete: true, more: 'YES' })
    })
    expect(ask).toHaveBeenCalledTimes(3)
    for (const call of ask.mock.calls) expect(call.slice(0, 3)).toEqual(['тигролови', 3, 10])
  })

  it('поки довантаження триває, стан — ready, але complete=false (не кінець списку)', async () => {
    ask
      .mockResolvedValueOnce(response({ complete: false, more: 'UNKNOWN' }))
      .mockReturnValue(new Promise(() => undefined))

    const { result } = renderHook(() => useExternalSearch('тигролови', 3, 10))

    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', complete: false })
    })
  })

  it('цикл довантаження скінченний, навіть якщо сервер ніколи не каже complete', async () => {
    ask.mockResolvedValue(response({ complete: false, more: 'UNKNOWN' }))

    const { result } = renderHook(() => useExternalSearch('тигролови', 3, 10))

    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', complete: true })
    })
    expect(ask).toHaveBeenCalledTimes(SEARCH_MAX_PAGE + 2)
  })

  it('зміна ключа перериває довантаження попереднього й не малює його відповіді', async () => {
    const signals: AbortSignal[] = []
    ask.mockImplementation((_query, page, _size, signal) => {
      if (signal !== undefined) signals.push(signal)

      return page === 1
        ? Promise.resolve(response({ complete: false, more: 'UNKNOWN', page: 1 }))
        : Promise.resolve(response({ page: 2, more: 'YES' }))
    })

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useExternalSearch('тигролови', page, 10),
      { initialProps: { page: 1 } },
    )

    await waitFor(() => {
      expect(ask).toHaveBeenCalled()
    })

    rerender({ page: 2 })

    await waitFor(() => {
      expect(result.current).toMatchObject({ status: 'ready', page: 2, more: 'YES' })
    })
    expect(signals[0]?.aborted).toBe(true)
  })

  it('збій запиту — failed, а не порожній список', async () => {
    ask.mockRejectedValue(new Error('мережа'))

    const { result } = renderHook(() => useExternalSearch('тигролови', 1, 10))

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
    })
  })

  it('«Шукати» на тому ж запиті (refresh) питає знову', async () => {
    ask.mockResolvedValue(response())

    const { result, rerender } = renderHook(
      ({ refresh }: { refresh: number }) => useExternalSearch('тигролови', 1, 10, refresh),
      { initialProps: { refresh: 0 } },
    )

    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    await act(async () => {
      rerender({ refresh: 1 })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(2)
    })
  })
})
