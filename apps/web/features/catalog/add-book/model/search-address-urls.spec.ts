import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { addressKey, autoHref, clearedHref, manualHref } from './search-address-urls'

describe('addressKey', () => {
  it('distinguishes the mode for the same query', () => {
    expect(addressKey(true, 'kobzar')).not.toBe(addressKey(false, 'kobzar'))
  })

  it('distinguishes queries within one mode', () => {
    expect(addressKey(false, 'kobzar')).not.toBe(addressKey(false, 'kobzar '))
  })

  it('is stable for the same input', () => {
    expect(addressKey(true, 'kobzar')).toBe(addressKey(true, 'kobzar'))
  })
})

describe('autoHref', () => {
  it('writes q, drops page and the old auto flag, keeps other parameters, and ends with auto=1', () => {
    const current = new URLSearchParams('q=old&page=3&auto=1&keep=1')

    expect(autoHref(current, 'kobzar', DEFAULT_SEARCH_PAGE_SIZE)).toBe(
      '/catalog/new?q=kobzar&keep=1&auto=1',
    )
  })

  it('does not mutate the current parameters', () => {
    const current = new URLSearchParams('q=old&page=3&auto=1')

    autoHref(current, 'kobzar', DEFAULT_SEARCH_PAGE_SIZE)

    expect(current.toString()).toBe('q=old&page=3&auto=1')
  })
})

describe('clearedHref', () => {
  it('drops the search state and keeps everything else', () => {
    const current = new URLSearchParams('q=kobzar&page=2&pageSize=20&auto=1&keep=1')

    expect(clearedHref(current)).toBe('/catalog/new?keep=1')
  })

  it('is the bare path when nothing else is left', () => {
    expect(clearedHref(new URLSearchParams('q=kobzar&auto=1'))).toBe('/catalog/new')
  })

  it('does not mutate the current parameters', () => {
    const current = new URLSearchParams('q=kobzar&auto=1')

    clearedHref(current)

    expect(current.toString()).toBe('q=kobzar&auto=1')
  })
})

describe('manualHref', () => {
  const base = { isbn: undefined, autoActive: false, enabled: false, urlQuery: '', query: '' }

  it('opens an empty form when nothing is searched', () => {
    expect(manualHref(base)).toBe('/catalog/new?mode=manual')
  })

  it('carries an ISBN instead of a title, even when a text query is active', () => {
    expect(
      manualHref({ ...base, isbn: '9783161484100', enabled: true, urlQuery: 'x', query: 'x' }),
    ).toBe('/catalog/new?mode=manual&isbn=9783161484100')
  })

  it('carries the normalized text while suggestions are shown', () => {
    expect(manualHref({ ...base, autoActive: true, urlQuery: 'kobzar', query: 'kobzar  ' })).toBe(
      '/catalog/new?mode=manual&title=kobzar',
    )
  })

  it('carries the executed query after a full search', () => {
    expect(manualHref({ ...base, enabled: true, urlQuery: 'kobzar', query: 'kobzar' })).toBe(
      '/catalog/new?mode=manual&title=kobzar',
    )
  })

  it('prefers suggestions text over the executed query when both flags are set', () => {
    expect(
      manualHref({ ...base, autoActive: true, enabled: true, urlQuery: 'a b', query: 'a  b' }),
    ).toBe('/catalog/new?mode=manual&title=a+b')
  })
})
