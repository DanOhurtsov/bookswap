/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { LibraryQueryRequest } from '@bookswap/shared'
import { useLibraryFilters } from './use-library-filters'

function setup(initial: LibraryQueryRequest = {}) {
  const onApply = jest.fn()
  const rendered = renderHook(
    ({ applied }: { applied: LibraryQueryRequest }) => useLibraryFilters({ applied, onApply }),
    { initialProps: { applied: initial } },
  )

  return { ...rendered, onApply }
}

describe('useLibraryFilters', () => {
  it('starts with an empty draft when nothing is applied', () => {
    const { result } = setup()

    expect(result.current.draft).toEqual({ status: '', lang: '', query: '' })
    expect(result.current.errors).toEqual({})
  })

  it('starts from the filters the address already holds', () => {
    const { result } = setup({ q: 'Шантарам', status: 'AVAILABLE', lang: 'uk' })

    expect(result.current.draft).toEqual({ status: 'AVAILABLE', lang: 'uk', query: 'Шантарам' })
  })

  it('typing changes the draft and applies nothing', () => {
    const { result, onApply } = setup()

    act(() => {
      result.current.setQuery('Шантарам')
    })

    expect(result.current.draft.query).toBe('Шантарам')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('apply hands over the filled fields, and leaves blank ones out', () => {
    const { result, onApply } = setup()

    act(() => {
      result.current.setStatus('AVAILABLE')
      result.current.setLang('uk')
      result.current.setQuery('Шантарам')
    })
    act(() => {
      result.current.apply()
    })

    expect(onApply).toHaveBeenLastCalledWith({ status: 'AVAILABLE', lang: 'uk', q: 'Шантарам' })

    act(() => {
      result.current.setStatus('')
      result.current.setLang('  ')
      result.current.setQuery('  ')
    })
    act(() => {
      result.current.apply()
    })

    expect(onApply).toHaveBeenLastCalledWith({})
  })

  it('an invalid draft shows its errors and applies nothing; a valid one clears them', () => {
    const { result, onApply } = setup()

    act(() => {
      result.current.setStatus('NOT_A_STATUS')
    })
    act(() => {
      result.current.apply()
    })

    expect(Object.keys(result.current.errors)).toEqual(['status'])
    expect(onApply).not.toHaveBeenCalled()

    act(() => {
      result.current.setStatus('')
    })
    act(() => {
      result.current.apply()
    })

    expect(result.current.errors).toEqual({})
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('follows the applied filters when they change under the form, and drops what was typed', () => {
    const { result, rerender } = setup({ q: 'Шантарам' })

    act(() => {
      result.current.setQuery('щось інше')
    })
    rerender({ applied: { q: 'Тінь вітру' } })

    expect(result.current.draft.query).toBe('Тінь вітру')

    rerender({ applied: {} })

    expect(result.current.draft.query).toBe('')
  })

  it('keeps the draft while the applied filters stay the same', () => {
    const { result, rerender } = setup({ q: 'Шантарам' })

    act(() => {
      result.current.setQuery('щось інше')
    })
    rerender({ applied: { q: 'Шантарам' } })

    expect(result.current.draft.query).toBe('щось інше')
  })
})
