/** @jest-environment jsdom */

import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { act, renderHook } from '@testing-library/react'
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
  it('search: replaces with the full search, first page, no auto flag, without scrolling; typed and ours', () => {
    const { router, result } = setup({
      parameters: new URLSearchParams('q=old&page=3&pageSize=24&auto=1&keep=1'),
      pageSize: 24,
      q: 'old',
    })

    act(() => {
      result.current.search('kobzar')
    })

    expect(router.replace).toHaveBeenCalledWith(
      '/catalog/new?q=kobzar&pageSize=24&keep=1',
      NO_SCROLL,
    )
    expect(result.current.typed).toBe(true)
    expect(result.current.adoptExternal('kobzar')).toBe(false)
  })

  it('search: does nothing when we already started a full search of that text', () => {
    const { router, result } = setup()

    act(() => {
      result.current.pushFull('kobzar')
    })
    act(() => {
      result.current.search('kobzar')
    })

    expect(router.replace).not.toHaveBeenCalled()
    expect(result.current.typed).toBe(false)
  })

  it('search: a different text than the pending full search still goes through', () => {
    const { router, result } = setup()

    act(() => {
      result.current.pushFull('kobzar')
    })
    act(() => {
      result.current.search('kobzar 2')
    })

    expect(router.replace).toHaveBeenCalledTimes(1)
  })

  it('clear: a typed search — replaces with the address without a query, and that is ours', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('q=kobzar&keep=1') })

    act(() => {
      result.current.search('kobzar')
    })
    act(() => {
      result.current.clear()
    })

    expect(router.replace).toHaveBeenLastCalledWith('/catalog/new?keep=1', NO_SCROLL)
    expect(result.current.typed).toBe(false)
    expect(result.current.adoptExternal('')).toBe(false)
  })

  it('clear: an explicit or outside search stays', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('q=kobzar'), q: 'kobzar' })

    act(() => {
      result.current.clear()
    })
    act(() => {
      result.current.pushFull('shevchenko')
    })
    act(() => {
      result.current.clear()
    })

    expect(router.replace).not.toHaveBeenCalled()
  })

  it('exact: replaces with the full search of the ISBN, no auto flag, and that is ours', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('auto=1&keep=1') })

    act(() => {
      result.current.exact(ISBN)
    })

    expect(router.replace).toHaveBeenCalledWith(`/catalog/new?q=${ISBN}&keep=1`, NO_SCROLL)
    expect(result.current.typed).toBe(false)
    expect(result.current.adoptExternal(ISBN)).toBe(false)
  })

  it('pushFull: pushes the full search (history entry, default scroll), and that is ours', () => {
    const { router, result } = setup({ parameters: new URLSearchParams('page=3&auto=1') })

    act(() => {
      result.current.pushFull('kobzar')
    })

    expect(router.push).toHaveBeenCalledWith('/catalog/new?q=kobzar')
    expect(router.replace).not.toHaveBeenCalled()
    expect(result.current.adoptExternal('kobzar')).toBe(false)
  })

  it('an explicit search after a typed one is no longer typed', () => {
    const { result } = setup()

    act(() => {
      result.current.search('kobz')
    })
    act(() => {
      result.current.pushFull('kobzar')
    })

    expect(result.current.typed).toBe(false)
  })
})

describe('useSearchAddressSync — the scanner is not ours', () => {
  it('showScanned: pushes the same address a full search would, but the field must follow it', () => {
    const { router, result } = setup()

    act(() => {
      result.current.showScanned(ISBN)
    })

    expect(router.push).toHaveBeenCalledWith(`/catalog/new?q=${ISBN}`)
    expect(result.current.adoptExternal(ISBN)).toBe(true)
  })
})

describe('useSearchAddressSync — adoptExternal', () => {
  it('does not treat the address of the first render as external', () => {
    const { result } = setup({ q: 'kobzar' })

    expect(result.current.adoptExternal('kobzar')).toBe(false)
  })

  it('treats any other address as external, once, and it is not typed', () => {
    const { result } = setup({ q: 'kobzar' })

    act(() => {
      result.current.search('kobz')
    })

    let adopted = false

    act(() => {
      adopted = result.current.adoptExternal('shevchenko')
    })

    expect(adopted).toBe(true)
    expect(result.current.adoptExternal('shevchenko')).toBe(false)
    expect(result.current.typed).toBe(false)
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
    act(() => {
      result.current.pushFull('kobzar')
    })

    expect(router.push).toHaveBeenCalledWith('/catalog/new?q=kobzar&keep=1')
  })
})
