/** @jest-environment jsdom */

import { act, fireEvent, renderHook } from '@testing-library/react'
import { useUnsavedChanges } from './use-unsaved-changes'

function renderGuard(initial: { dirty: boolean; locked?: boolean }) {
  const leave = jest.fn()
  const hook = renderHook(({ dirty, locked }) => useUnsavedChanges({ dirty, locked, leave }), {
    initialProps: { dirty: initial.dirty, locked: initial.locked ?? false },
  })

  return { ...hook, leave }
}

function closeTab(): Event {
  const event = new Event('beforeunload', { cancelable: true })

  window.dispatchEvent(event)

  return event
}

describe('useUnsavedChanges', () => {
  it('без змін «Скасувати» одразу виходить, а закриття вкладки не питає', () => {
    const { result, leave } = renderGuard({ dirty: false })

    act(() => {
      result.current.cancel()
    })

    expect(leave).toHaveBeenCalledTimes(1)
    expect(result.current.confirming).toBe(false)
    expect(closeTab().defaultPrevented).toBe(false)
  })

  it('зі змінами — спершу питає; «Продовжити редагування» лишає у формі, «Скасувати зміни» виходить', () => {
    const { result, leave } = renderGuard({ dirty: true })

    act(() => {
      result.current.cancel()
    })
    expect(result.current.confirming).toBe(true)
    expect(leave).not.toHaveBeenCalled()

    act(() => {
      result.current.keepEditing()
    })
    expect(result.current.confirming).toBe(false)

    act(() => {
      result.current.cancel()
    })
    act(() => {
      result.current.discard()
    })
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('Esc — це «Скасувати», а при відкритому питанні — «Продовжити редагування»', () => {
    const { result, leave } = renderGuard({ dirty: true })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(result.current.confirming).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(result.current.confirming).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })

  it('Esc, який уже використало спливне вікно, форму не скасовує', () => {
    const { leave } = renderGuard({ dirty: false })
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    event.preventDefault()
    act(() => {
      document.dispatchEvent(event)
    })

    expect(leave).not.toHaveBeenCalled()
  })

  it('зі змінами закриття вкладки отримує попередження браузера', () => {
    const { rerender } = renderGuard({ dirty: true })

    expect(closeTab().defaultPrevented).toBe(true)

    rerender({ dirty: false, locked: false })

    expect(closeTab().defaultPrevented).toBe(false)
  })

  it('поки збереження триває, нічого не виходить', () => {
    const { result, leave } = renderGuard({ dirty: false, locked: true })

    act(() => {
      result.current.cancel()
    })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(leave).not.toHaveBeenCalled()
  })
})
