/** @jest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { ApiRequestError, describeError } from './api'
import { useApiResource } from './use-resource'

/**
 * BS-153: the error state carries the API's HTTP status beside the message, so a page can tell
 * «not found» from «server down». The message is what it was; without a response there is no status.
 */

jest.mock('./api', () => {
  const actual = jest.requireActual<typeof import('./api')>('./api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('./api')

const schema = z.object({ ok: z.boolean() })

beforeEach(() => {
  apiRequest.mockReset()
})

describe('useApiResource: статус відповіді в стані помилки', () => {
  it.each([403, 404, 500])(
    'відповідь API %i — статус поруч із тим самим повідомленням',
    async (status) => {
      apiRequest.mockRejectedValue(
        new ApiRequestError(status, { code: 'NOT_FOUND', message: 'Немає' }),
      )

      const { result } = renderHook(() => useApiResource('/thing', schema))

      await waitFor(() => {
        expect(result.current.state).toEqual({
          status: 'error',
          message: 'Немає',
          httpStatus: status,
        })
      })
    },
  )

  it('без відповіді (мережа) статусу немає взагалі — і повідомлення те саме, що й раніше', async () => {
    const network = new TypeError('Failed to fetch')

    apiRequest.mockRejectedValue(network)

    const { result } = renderHook(() => useApiResource('/thing', schema))

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
    expect(result.current.state).toStrictEqual({ status: 'error', message: describeError(network) })
  })

  it('успіх не змінився', async () => {
    apiRequest.mockResolvedValue({ ok: true })

    const { result } = renderHook(() => useApiResource('/thing', schema))

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ready', data: { ok: true } })
    })
  })
})
