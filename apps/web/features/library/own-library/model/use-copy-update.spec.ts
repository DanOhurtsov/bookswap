/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { useCopyUpdate } from './use-copy-update'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function setup() {
  const log: string[] = []
  const onSaved = jest.fn(() => {
    log.push('onSaved')

    return Promise.resolve()
  })
  const onFailure = jest.fn()
  const { result } = renderHook(() => useCopyUpdate({ copyId: 'copy-1', onSaved, onFailure }))

  return { result, log, onSaved, onFailure }
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('useCopyUpdate', () => {
  it('PATCHes the copy, then runs afterSaved, then lets the shelf reload', async () => {
    const { result, log, onFailure } = setup()

    mockApiRequest.mockImplementation(() => {
      log.push('request')

      return Promise.resolve({})
    })

    await act(async () => {
      await result.current.patch({ status: 'UNAVAILABLE' }, () => {
        log.push('afterSaved')
      })
    })

    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/copy-1',
      expect.objectContaining({ method: 'PATCH', body: { status: 'UNAVAILABLE' } }),
    )
    expect(log).toEqual(['request', 'afterSaved', 'onSaved'])
    expect(onFailure).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  })

  it('is pending while the request is in flight', async () => {
    const { result } = setup()
    let finish: () => void = () => undefined

    mockApiRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({})
          }
        }),
    )

    act(() => {
      void result.current.patch({ status: 'AVAILABLE' })
    })

    await waitFor(() => {
      expect(result.current.pending).toBe(true)
    })

    await act(async () => {
      finish()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
  })

  it('a failed request reports the API error as it is and does not run afterSaved or reload', async () => {
    const { result, onSaved, onFailure } = setup()
    const afterSaved = jest.fn()
    const error = new ApiRequestError(409, { code: 'CONFLICT', message: 'Конфлікт' })

    mockApiRequest.mockRejectedValue(error)

    await act(async () => {
      await result.current.patch({ status: 'AVAILABLE' }, afterSaved)
    })

    expect(onFailure).toHaveBeenCalledWith(error)
    expect(afterSaved).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  })

  it('any other error is reported as the generic message', async () => {
    const { result, onFailure } = setup()
    const error = new Error('мережа')

    mockApiRequest.mockRejectedValue(error)

    await act(async () => {
      await result.current.patch({ status: 'AVAILABLE' })
    })

    expect(onFailure).toHaveBeenCalledWith(new Error(describeError(error)))
  })
})
