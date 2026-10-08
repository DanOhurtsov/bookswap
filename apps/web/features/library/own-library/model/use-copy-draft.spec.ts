/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { OwnCopy } from '@bookswap/shared'
import { useCopyDraft } from './use-copy-draft'

function copy(overrides: Record<string, unknown> = {}): OwnCopy {
  return {
    id: 'copy-1',
    condition: 'GOOD',
    visibility: 'FRIENDS',
    note: null,
    acquiredAt: null,
    ...overrides,
  } as unknown as OwnCopy
}

describe('useCopyDraft', () => {
  it('starts from the copy, with an empty note and date where the copy has none', () => {
    const { result } = renderHook(() => useCopyDraft(copy()))

    expect(result.current).toMatchObject({
      condition: 'GOOD',
      visibility: 'FRIENDS',
      note: '',
      acquiredAt: '',
      errors: {},
    })

    const filled = renderHook(() => useCopyDraft(copy({ note: 'стара', acquiredAt: '2026-01-02' })))

    expect(filled.result.current).toMatchObject({ note: 'стара', acquiredAt: '2026-01-02' })
  })

  it('submit returns the whole request body; a blank note and date become null', () => {
    const { result } = renderHook(() => useCopyDraft(copy({ note: 'стара' })))

    act(() => {
      result.current.setCondition('WORN')
      result.current.setNote('   ')
    })

    let body: unknown

    act(() => {
      body = result.current.submit()
    })

    expect(body).toEqual({
      condition: 'WORN',
      visibility: 'FRIENDS',
      note: null,
      acquiredAt: null,
    })
  })

  it('an invalid draft submits nothing and shows the error; a valid one clears it', () => {
    const { result } = renderHook(() => useCopyDraft(copy()))

    act(() => {
      result.current.setAcquiredAt('не дата')
    })

    let body: unknown = 'untouched'

    act(() => {
      body = result.current.submit()
    })

    expect(body).toBeUndefined()
    expect(Object.keys(result.current.errors)).toEqual(['acquiredAt'])

    act(() => {
      result.current.setAcquiredAt('')
    })
    act(() => {
      body = result.current.submit()
    })

    expect(body).toBeDefined()
    expect(result.current.errors).toEqual({})
  })
})
