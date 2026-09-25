import {
  DEFAULT_DISCOVERY_FILTERS,
  discoveryHref,
  discoveryQuery,
  readDiscoveryFilters,
} from './discovery-filters'

const address = { q: '', page: 1, pageSize: 10 as const }

describe('discovery filters in the address', () => {
  it('round-trips non-default filters, q, page and pageSize', () => {
    const filters = { availability: 'ANY', language: 'uk', translation: 'TRANSLATED' } as const
    const href = discoveryHref({ q: 'Кобзар', page: 2, pageSize: 20 }, 'CIRCLE', filters)
    const parameters = new URL(href, 'http://x').searchParams

    expect(parameters.get('q')).toBe('Кобзар')
    expect(parameters.get('page')).toBe('2')
    expect(parameters.get('pageSize')).toBe('20')
    expect(readDiscoveryFilters(parameters)).toEqual({ filters, valid: true })
  })

  it('omits defaults: browse without filters is plain /catalog', () => {
    expect(discoveryHref(address, 'CIRCLE', DEFAULT_DISCOVERY_FILTERS)).toBe('/catalog')
  })

  it('a filter change starts from page 1 when the caller resets the page', () => {
    const href = discoveryHref({ ...address, page: 1 }, 'CIRCLE', {
      ...DEFAULT_DISCOVERY_FILTERS,
      language: 'pl',
    })

    expect(href).toBe('/catalog?language=pl')
  })

  it('ALL scope drops filters and keeps scope', () => {
    const href = discoveryHref({ ...address, q: 'книга' }, 'ALL', {
      availability: 'ANY',
      language: 'uk',
      translation: 'ORIGINAL',
    })

    expect(href).toBe('/catalog?q=%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0&scope=ALL')
  })

  it('flags unknown filter values as invalid and falls back to defaults', () => {
    const read = readDiscoveryFilters(
      new URLSearchParams('availability=NOPE&language=zz&translation=X'),
    )

    expect(read.valid).toBe(false)
    expect(read.filters).toEqual(DEFAULT_DISCOVERY_FILTERS)
  })
})

describe('discoveryQuery', () => {
  it('sends filters only in CIRCLE and no empty q', () => {
    const circle = new URLSearchParams(
      discoveryQuery({
        q: '',
        page: 1,
        pageSize: 10,
        scope: 'CIRCLE',
        filters: DEFAULT_DISCOVERY_FILTERS,
      }),
    )

    expect(circle.has('q')).toBe(false)
    expect(circle.get('availability')).toBe('AVAILABLE')
    expect(circle.get('translation')).toBe('ANY')

    const all = new URLSearchParams(
      discoveryQuery({
        q: 'ab',
        page: 1,
        pageSize: 10,
        scope: 'ALL',
        filters: DEFAULT_DISCOVERY_FILTERS,
      }),
    )

    expect(all.has('availability')).toBe(false)
    expect(all.has('translation')).toBe(false)
    expect(all.get('scope')).toBe('ALL')
  })
})
