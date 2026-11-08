/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { useSearchDraft } from './use-search-draft'

function setup(initial = '') {
  const write = jest.fn<undefined, [string]>()
  const hook = renderHook(({ applied }) => useSearchDraft(applied, write), {
    initialProps: { applied: initial },
  })

  return { write, hook }
}

describe('useSearchDraft: текст пошуку окремо від ?q= (BS-153)', () => {
  it('починає з пошуку з адреси', () => {
    expect(setup('Дюна').hook.result.current.draft).toBe('Дюна')
  })

  it('введене одразу в полі й записується в адресу як є', () => {
    const { write, hook } = setup()

    act(() => {
      hook.result.current.change('Дю')
    })

    expect(hook.result.current.draft).toBe('Дю')
    expect(write).toHaveBeenLastCalledWith('Дю')
  })

  it('запізніле відлуння власного запису не затирає швидше введений текст', () => {
    const { hook } = setup()

    act(() => {
      hook.result.current.change('Д')
      hook.result.current.change('Дю')
      hook.result.current.change('Дюн')
    })
    hook.rerender({ applied: 'Д' })
    expect(hook.result.current.draft).toBe('Дюн')

    hook.rerender({ applied: 'Дюн' })
    expect(hook.result.current.draft).toBe('Дюн')
  })

  it('пробіли — це «без пошуку» в адресі, але в полі лишаються', () => {
    const { write, hook } = setup('x')

    act(() => {
      hook.result.current.change('  ')
    })
    hook.rerender({ applied: '' })

    expect(write).toHaveBeenLastCalledWith('  ')
    expect(hook.result.current.draft).toBe('  ')
  })

  it('зміна адреси з іншої причини (скидання, посилання) замінює текст поля', () => {
    const { hook } = setup('Дюна')

    hook.rerender({ applied: '' })
    expect(hook.result.current.draft).toBe('')

    hook.rerender({ applied: 'Орвелл' })
    expect(hook.result.current.draft).toBe('Орвелл')
  })

  it('після власних записів зовнішня зміна все одно впізнається', () => {
    const { hook } = setup()

    act(() => {
      hook.result.current.change('Дюна')
    })
    hook.rerender({ applied: 'Дюна' })
    hook.rerender({ applied: '' })

    expect(hook.result.current.draft).toBe('')
  })
})
