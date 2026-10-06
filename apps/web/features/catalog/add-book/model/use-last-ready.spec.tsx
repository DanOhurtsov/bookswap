/** @jest-environment jsdom */

import { renderHook } from '@testing-library/react'
import { useLastReady } from './use-last-ready'

interface Props {
  value: string | undefined
  active: boolean
}

function setup(initial: Props) {
  let renders = 0
  const hook = renderHook(
    (props: Props) => {
      renders += 1

      return useLastReady(props.value, props.active)
    },
    { initialProps: initial },
  )

  return { ...hook, renders: () => renders }
}

describe('useLastReady', () => {
  it('has nothing before the first value', () => {
    expect(setup({ value: undefined, active: true }).result.current).toBeUndefined()
  })

  it('remembers a value while active', () => {
    expect(setup({ value: 'a', active: true }).result.current).toBe('a')
  })

  it('keeps the previous value while the next one is still loading', () => {
    const { result, rerender } = setup({ value: 'a', active: true })

    rerender({ value: undefined, active: true })

    expect(result.current).toBe('a')
  })

  it('replaces the remembered value as a whole when the next one arrives', () => {
    const { result, rerender } = setup({ value: 'a', active: true })

    rerender({ value: undefined, active: true })
    rerender({ value: 'b', active: true })

    expect(result.current).toBe('b')
  })

  it('forgets everything the moment it stops being active', () => {
    const { result, rerender } = setup({ value: 'a', active: true })

    rerender({ value: 'a', active: false })

    expect(result.current).toBeUndefined()
  })

  it('never remembers while inactive', () => {
    const { result, rerender } = setup({ value: 'a', active: false })

    expect(result.current).toBeUndefined()

    rerender({ value: 'b', active: false })

    expect(result.current).toBeUndefined()
  })

  it('does not bring back the old value when it becomes active again with nothing ready', () => {
    const { result, rerender } = setup({ value: 'a', active: true })

    rerender({ value: undefined, active: false })
    rerender({ value: undefined, active: true })

    expect(result.current).toBeUndefined()
  })

  it('settles: an unchanged value costs one render, not a loop', () => {
    const { rerender, renders } = setup({ value: 'a', active: true })
    const before = renders()

    rerender({ value: 'a', active: true })

    expect(renders() - before).toBe(1)
  })
})
