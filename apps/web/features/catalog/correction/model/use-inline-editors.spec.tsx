/** @jest-environment jsdom */

import { zodResolver } from '@hookform/resolvers/zod'
import { act, renderHook } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useInlineEditors } from './use-inline-editors'

/**
 * BS-76: inline editor state over ONE react-hook-form draft. Opening changes nothing; «Скасувати»
 * restores only its own field; an editor's own «Зберегти» only validates.
 */
const schema = z.object({
  title: z.string().trim().min(1, 'Не вказано назву'),
  note: z.string().nullable(),
  tags: z.array(z.string()),
})

type Values = z.infer<typeof schema>

function renderEditors() {
  return renderHook(() => {
    const form = useForm<Values>({
      resolver: zodResolver(schema),
      defaultValues: { title: 'Кобзар', note: null, tags: ['a'] },
    })

    // Read during render, as a form does: RHF re-renders only for the
    // `formState` keys a render actually subscribed to.
    const { errors, dirtyFields, isDirty } = form.formState

    return { form, errors, dirtyFields, isDirty, editors: useInlineEditors(form) }
  })
}

it('відкриття й закриття без змін не змінює значення й dirty state', () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('title')
  })

  expect(result.current.editors.isOpen('title')).toBe(true)
  expect(result.current.form.getValues('title')).toBe('Кобзар')
  expect(result.current.isDirty).toBe(false)

  act(() => {
    result.current.editors.cancel('title')
  })

  expect(result.current.editors.isOpen('title')).toBe(false)
  expect(result.current.form.getValues()).toEqual({ title: 'Кобзар', note: null, tags: ['a'] })
  expect(result.current.dirtyFields).toEqual({})
})

it('«Скасувати» повертає значення саме цього редактора й не чіпає інших полів', async () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('note')
    result.current.form.setValue('note', 'підтверджена примітка', { shouldDirty: true })
  })
  await act(() => result.current.editors.confirm('note'))

  act(() => {
    result.current.editors.open('title')
    result.current.form.setValue('title', 'Чернетка', { shouldDirty: true })
  })
  act(() => {
    result.current.editors.cancel('title')
  })

  expect(result.current.form.getValues('title')).toBe('Кобзар')
  expect(result.current.form.getValues('note')).toBe('підтверджена примітка')
  // Restored to the default: pristine again, so a dirty-only field is not sent.
  expect(result.current.dirtyFields.title).toBeUndefined()
})

it('локальне «Зберегти» з невалідним значенням лишає редактор відкритим і ставить помилку', async () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('title')
    result.current.form.setValue('title', '  ')
  })
  await act(() => result.current.editors.confirm('title'))

  expect(result.current.editors.isOpen('title')).toBe(true)
  expect(result.current.errors.title?.message).toBe('Не вказано назву')

  act(() => {
    result.current.editors.cancel('title')
  })

  expect(result.current.form.getValues('title')).toBe('Кобзар')
  expect(result.current.errors.title).toBeUndefined()
})

it('reveal відкриває невалідні поля, closeAll закриває всі без зміни значень', () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('note')
    result.current.editors.reveal(['title', 'tags'])
  })

  expect(result.current.editors.isOpen('title')).toBe(true)
  expect(result.current.editors.isOpen('note')).toBe(true)
  expect(result.current.editors.isOpen('tags')).toBe(true)

  act(() => {
    result.current.editors.closeAll()
  })

  expect(result.current.editors.isOpen('title')).toBe(false)
  expect(result.current.editors.isOpen('note')).toBe(false)
  expect(result.current.form.getValues()).toEqual({ title: 'Кобзар', note: null, tags: ['a'] })
})

it('знімок не залежить від мутацій вкладеного значення на місці (як робить useController)', () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('tags')
  })
  act(() => {
    // RHF writes `tags.0` into the SAME array object the snapshot was read from.
    result.current.form.setValue('tags.0', 'змінено')
  })
  act(() => {
    result.current.editors.cancel('tags')
  })

  expect(result.current.form.getValues('tags')).toEqual(['a'])
})

it('rebaseSnapshot: скасування повертає канонічне значення, а не вже спожите сервером', () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('tags')
  })
  act(() => {
    result.current.editors.rebaseSnapshot('tags', ['a'], ['a-canonical'])
    result.current.form.setValue('tags', ['змінено'])
  })
  act(() => {
    result.current.editors.cancel('tags')
  })

  expect(result.current.form.getValues('tags')).toEqual(['a-canonical'])
})

it('rebaseSnapshot не чіпає знімок, який відрізняється від `from`', () => {
  const { result } = renderEditors()

  act(() => {
    result.current.editors.open('tags')
  })
  act(() => {
    result.current.editors.rebaseSnapshot('tags', ['інше'], ['a-canonical'])
    result.current.form.setValue('tags', ['змінено'])
  })
  act(() => {
    result.current.editors.cancel('tags')
  })

  expect(result.current.form.getValues('tags')).toEqual(['a'])
})
