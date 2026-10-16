/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import type { Visibility } from '@bookswap/shared'
import type { QuickAddSlot } from './quick-add-slots'
import { useCopyVisibilityDraft } from './use-copy-visibility-draft'

/**
 * BS-79: the new copy's «Кому показувати» starts from the profile once, when the form mounts; a later
 * profile update never resets it; while an operation is unresolved the choice is frozen with it.
 */
type Props = { libraryVisibility: Visibility; slot: QuickAddSlot | undefined }

function renderDraft(initial: Props) {
  return renderHook(
    ({ libraryVisibility, slot }: Props) => useCopyVisibilityDraft(libraryVisibility, slot),
    { initialProps: initial },
  )
}

const PENDING: QuickAddSlot = {
  status: 'pending',
  operationId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60',
  request: {
    operationId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60',
    copy: { visibility: 'PRIVATE' },
    target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
  },
  added: 0,
}

it('починає зі значення профілю й надсилає його явно', () => {
  const { result } = renderDraft({ libraryVisibility: 'PUBLIC', slot: undefined })

  expect(result.current.value).toBe('PUBLIC')
  expect(result.current.copy).toEqual({ visibility: 'PUBLIC' })
})

it('оновлення профілю не скидає незайманий вибір', () => {
  const { result, rerender } = renderDraft({ libraryVisibility: 'PUBLIC', slot: undefined })

  rerender({ libraryVisibility: 'PRIVATE', slot: undefined })

  expect(result.current.value).toBe('PUBLIC')
  expect(result.current.copy).toEqual({ visibility: 'PUBLIC' })
})

it('оновлення профілю не скидає вибір людини', () => {
  const { result, rerender } = renderDraft({ libraryVisibility: 'FRIENDS', slot: undefined })

  act(() => {
    result.current.change('PRIVATE')
  })
  rerender({ libraryVisibility: 'PUBLIC', slot: undefined })

  expect(result.current.value).toBe('PRIVATE')
  expect(result.current.copy).toEqual({ visibility: 'PRIVATE' })
})

it('поки операція не завершена — показує надіслане значення, а зміна нічого не робить', () => {
  const { result, rerender } = renderDraft({ libraryVisibility: 'PUBLIC', slot: PENDING })

  expect(result.current).toMatchObject({ value: 'PRIVATE', isLocked: true })

  act(() => {
    result.current.change('FRIENDS')
  })
  rerender({ libraryVisibility: 'PUBLIC', slot: undefined })

  // The draft was never touched by the ignored change.
  expect(result.current).toMatchObject({ value: 'PUBLIC', isLocked: false })
})

it('після відмови повертає надіслане значення, а зміну людини вже не перезаписує', () => {
  const rejected: QuickAddSlot = {
    status: 'rejected',
    added: 0,
    message: 'Ні',
    operationId: PENDING.operationId,
    request: PENDING.request,
  }
  const { result, rerender } = renderDraft({ libraryVisibility: 'PUBLIC', slot: rejected })

  expect(result.current).toMatchObject({ value: 'PRIVATE', isLocked: false })
  expect(result.current.copy).toEqual({ visibility: 'PRIVATE' })

  act(() => {
    result.current.change('FRIENDS')
  })
  rerender({ libraryVisibility: 'PRIVATE', slot: rejected })

  expect(result.current.value).toBe('FRIENDS')
  expect(result.current.copy).toEqual({ visibility: 'FRIENDS' })
})
