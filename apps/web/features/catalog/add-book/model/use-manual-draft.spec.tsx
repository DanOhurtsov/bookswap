/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { EMPTY_MANUAL_FORM, type ManualFormValues } from './manual-form'
import { useManualDraft } from './use-manual-draft'

/**
 * BS-76: the manual draft with inline editors. Opening changes nothing; «Скасувати» restores only its
 * own field; an editor's own «Зберегти» only validates; the general submit owns closing and revealing.
 */
const INITIAL: ManualFormValues = {
  ...EMPTY_MANUAL_FORM,
  title: 'Кобзар',
  authors: ['Тарас Шевченко'],
}

function renderDraft(initial: ManualFormValues = INITIAL, presetWorkId?: string) {
  return renderHook(() => useManualDraft(initial, presetWorkId))
}

it('відкриття не змінює чернетку; закриття без змін теж', () => {
  const { result } = renderDraft()

  act(() => {
    result.current.open('title')
  })

  expect(result.current.isOpen('title')).toBe(true)
  expect(result.current.values).toEqual(INITIAL)

  act(() => {
    result.current.cancel('title')
  })

  expect(result.current.isOpen('title')).toBe(false)
  expect(result.current.values).toEqual(INITIAL)
})

it('«Скасувати» повертає значення саме цього редактора й не чіпає інших змін', () => {
  const { result } = renderDraft()

  act(() => {
    result.current.open('title')
    result.current.open('publisher')
  })
  act(() => {
    result.current.change('title', 'Інша')
    result.current.change('publisher', 'Наука')
  })
  act(() => {
    result.current.cancel('title')
  })

  expect(result.current.values).toMatchObject({ title: 'Кобзар', publisher: 'Наука' })
  expect(result.current.isOpen('publisher')).toBe(true)
})

it('«Скасувати» авторів повертає незалежну копію списку з моменту відкриття', () => {
  const { result } = renderDraft()

  act(() => {
    result.current.open('authors')
  })
  act(() => {
    // Even an in-place edit of the draft's own array cannot reach the snapshot.
    result.current.values.authors[0] = 'Змінено на місці'
    result.current.change('authors', [...result.current.values.authors, 'Другий'])
  })
  act(() => {
    result.current.cancel('authors')
  })

  expect(result.current.values.authors).toEqual(['Тарас Шевченко'])
})

it('«Зберегти» з невалідним значенням лишає редактор відкритим і ставить помилку лише цьому полю', () => {
  const { result } = renderDraft({ ...INITIAL, title: '' })

  act(() => {
    result.current.open('year')
  })
  act(() => {
    result.current.change('year', '20x0')
  })
  act(() => {
    result.current.confirm('year')
  })

  expect(result.current.isOpen('year')).toBe(true)
  expect(result.current.errors).toEqual({ year: 'Потрібне ціле число' })

  act(() => {
    result.current.change('year', '2020')
  })
  act(() => {
    result.current.confirm('year')
  })

  expect(result.current.isOpen('year')).toBe(false)
  expect(result.current.errors.year).toBeUndefined()
  expect(result.current.values.year).toBe('2020')
})

it('успішне загальне додавання повертає ціль із відкритих редакторів і закриває їх', () => {
  const { result } = renderDraft()

  act(() => {
    result.current.open('publisher')
  })
  act(() => {
    result.current.change('publisher', 'Наука')
  })

  let target: ReturnType<typeof result.current.submit>

  act(() => {
    target = result.current.submit()
  })

  expect(target).toMatchObject({ edition: { publisher: 'Наука' } })
  expect(result.current.isOpen('publisher')).toBe(false)
})

it('невдале загальне додавання відкриває невалідні поля та їхні розділи', () => {
  const { result } = renderDraft({ ...INITIAL, title: '', firstPubYear: 'x' })

  expect(result.current.isSectionOpen('extra')).toBe(false)

  let target: ReturnType<typeof result.current.submit>

  act(() => {
    target = result.current.submit()
  })

  expect(target).toBeUndefined()
  expect(result.current.isOpen('title')).toBe(true)
  expect(result.current.isOpen('firstPubYear')).toBe(true)
  expect(result.current.isOpen('authors')).toBe(false)
  expect(result.current.isSectionOpen('extra')).toBe(true)
  expect(result.current.isSectionOpen('translation')).toBe(false)
  expect(result.current.errors).toMatchObject({
    title: 'Вкажіть назву',
    firstPubYear: 'Потрібне ціле число',
  })
})
