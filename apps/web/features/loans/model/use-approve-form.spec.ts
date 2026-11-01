/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { approveBody, useApproveForm } from './use-approve-form'
import { initialDueDate } from './approve-due-date'

describe('approveBody (BS-147)', () => {
  it('sends the date and the answer that are filled in', () => {
    expect(approveBody('2026-11-15', 'Забирай у суботу')).toEqual({
      dueAt: '2026-11-15',
      note: 'Забирай у суботу',
    })
  })

  it('sends neither an empty date nor a blank answer', () => {
    expect(approveBody('', '   ')).toEqual({})
    expect(approveBody('2026-11-15', '')).toEqual({ dueAt: '2026-11-15' })
    expect(approveBody('', 'Так')).toEqual({ note: 'Так' })
  })
})

describe('useApproveForm (BS-147)', () => {
  it('starts from the borrower’s date or the owner’s term, with no answer', () => {
    const asked = renderHook(() => useApproveForm({ dueAt: '2026-12-01' }, 30))
    const termed = renderHook(() => useApproveForm({ dueAt: null }, 14))

    expect(asked.result.current.dueAt).toBe('2026-12-01')
    expect(termed.result.current.dueAt).toBe(initialDueDate(null, 14, new Date()))
    expect(termed.result.current.note).toBe('')
  })

  it('builds the body from what is typed', () => {
    const { result } = renderHook(() => useApproveForm({ dueAt: null }, null))

    expect(result.current.body).toEqual({})

    act(() => {
      result.current.setDueAt('2026-11-20')
      result.current.setNote('Тримай')
    })

    expect(result.current.body).toEqual({ dueAt: '2026-11-20', note: 'Тримай' })
  })
})
