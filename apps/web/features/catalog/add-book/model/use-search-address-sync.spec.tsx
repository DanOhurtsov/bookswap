/** @jest-environment jsdom */

import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { renderHook } from '@testing-library/react'
import { useSearchAddressSync, type SearchAddressSyncInput } from './use-search-address-sync'

const ISBN = '9783161484100'
const NO_SCROLL = { scroll: false }

function setup(overrides: Partial<SearchAddressSyncInput> = {}) {
  const router = {
    push: jest.fn<void, [string]>(),
    replace: jest.fn<void, [string, { scroll: boolean }]>(),
  }
  const input = (extra: Partial<SearchAddressSyncInput> = {}): SearchAddressSyncInput => ({
    router,
    parameters: new URLSearchParams(),
    pageSize: DEFAULT_SEARCH_PAGE_SIZE,
    autoMode: false,
    q: '',
    ...overrides,
    ...extra,
  })
  const hook = renderHook((props: SearchAddressSyncInput) => useSearchAddressSync(props), {
    initialProps: input(),
  })

  return { router, ...hook, input }
}

describe('useSearchAddressSync — writes from the field claim the address', () => {
  it('suggest: replaces with auto=1 without scrolling, and the address is then ours', () => {
    const { router, result } = setup()

    result.current.suggest('kobzar')

    expect(router.replace).toHaveBeenCalledWith('/catalog/new?q=kobzar&auto=1', NO_SCROLL)
    expect(result.current.adoptExternal(true, 'kobzar')).toBe(false)
  })

  it('suggest: does nothing when we already started a full search of that text', () => {
    const { router, result } = setup()

    result.current.pushFull('kobzar')
    result.current.suggest('kobzar')

    expect(router.replace).not.toHaveBeenCalled()
  })

  it('suggest: a different text than the pending full search still goes through', () => {
    const { router, result } = setup()

    result.current.pushFull('kobzar')
    result.current.suggest('kobzar 2')

    expect(router.replace).toHaveBeenCalledTimes(1)
  })

  it('clear: replaces with the address without a query, and that is ours', () => {
    const { router, result } = setup({
      parameters: new URLSearchParams('q=kobzar&auto=1&keep=1'),
      autoMode: true,
      q: 'kobzar',
    })

    result.current.clear()

    expect(router.replace).toHaveBeenCalledWith('/catalog/new?keep=1', NO_SCROLL)
    expect(result.current.adoptExternal(false, '')).toBe(false)
  })

  it('exact: replaces with the full search of the ISBN, no auto flag, and that is ours', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('auto=1&keep=1') })

    result.current.exact(ISBN)

    expect(router.replace).toHaveBeenCalledWith(`/catalog/new?q=${ISBN}&keep=1`, NO_SCROLL)
    expect(result.current.adoptExternal(false, ISBN)).toBe(false)
  })

  it('pushFull: pushes the full search (history entry, default scroll), and that is ours', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('page=3&auto=1') })

    result.current.pushFull('kobzar')

    expect(router.push).toHaveBeenCalledWith('/catalog/new?q=kobzar')
    expect(router.replace).not.toHaveBeenCalled()
    expect(result.current.adoptExternal(false, 'kobzar')).toBe(false)
  })
})

describe('useSearchAddressSync — the scanner is not ours', () => {
  it('showScanned: pushes the same address a full search would, but the field must follow it', () => {
    const { router, result } = setup()

    result.current.showScanned(ISBN)

    expect(router.push).toHaveBeenCalledWith(`/catalog/new?q=${ISBN}`)
    expect(result.current.adoptExternal(false, ISBN)).toBe(true)
  })
})

describe('useSearchAddressSync — adoptExternal', () => {
  it('does not treat the address of the first render as external', () => {
    const { result } = setup({ autoMode: true, q: 'kobzar' })

    expect(result.current.adoptExternal(true, 'kobzar')).toBe(false)
  })

  it('treats any other address as external, once', () => {
    const { result } = setup({ q: 'kobzar' })

    expect(result.current.adoptExternal(false, 'shevchenko')).toBe(true)
    expect(result.current.adoptExternal(false, 'shevchenko')).toBe(false)
  })

  it('tells the mode apart: the same text as suggestions is not our full search', () => {
    const { result } = setup({ q: 'kobzar' })

    expect(result.current.adoptExternal(true, 'kobzar')).toBe(true)
  })

  it('keeps one identity across renders, so it is safe in effect dependencies', () => {
    const { result, rerender, input } = setup()
    const first = result.current.adoptExternal

    rerender(input({ pageSize: DEFAULT_SEARCH_PAGE_SIZE, q: 'x' }))

    expect(result.current.adoptExternal).toBe(first)
  })

  it('writes with the parameters and page size of the latest render', () => {
    const { router, result, rerender, input } = setup()

    rerender(input({ parameters: new URLSearchParams('keep=1') }))
    result.current.pushFull('kobzar')

    expect(router.push).toHaveBeenCalledWith('/catalog/new?q=kobzar&keep=1')
  })
})
