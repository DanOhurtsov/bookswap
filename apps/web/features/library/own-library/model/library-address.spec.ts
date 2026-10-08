import {
  filtersKey,
  isLibraryView,
  libraryBookHref,
  libraryHref,
  readLibraryAddress,
} from './library-address'

const read = (search: string) => readLibraryAddress(new URLSearchParams(search))

describe('readLibraryAddress', () => {
  it('an empty address is the own view without filters', () => {
    expect(read('')).toEqual({ view: 'own', filters: {}, valid: true })
  })

  it.each(['own', 'out', 'borrowed', 'archive'] as const)('?view=%s opens that view', (view) => {
    expect(read(`view=${view}`)).toEqual({ view, filters: {}, valid: true })
  })

  it('reads the filters in the own view', () => {
    expect(read('q=Шантарам&status=AVAILABLE&lang=uk')).toEqual({
      view: 'own',
      filters: { q: 'Шантарам', status: 'AVAILABLE', lang: 'uk' },
      valid: true,
    })
  })

  it('does not read the filters in the other views', () => {
    expect(read('view=out&q=Шантарам')).toEqual({ view: 'out', filters: {}, valid: true })
  })

  it('an unknown view falls back to the own view and is reported', () => {
    expect(read('view=bogus&q=Шантарам')).toEqual({ view: 'own', filters: {}, valid: false })
  })

  it('an unreadable filter drops all of them and is reported', () => {
    expect(read('q=Шантарам&status=NOT_A_STATUS')).toEqual({
      view: 'own',
      filters: {},
      valid: false,
    })
  })

  it('an empty filter value is unreadable too', () => {
    expect(read('q=').valid).toBe(false)
  })
})

describe('libraryHref', () => {
  it('the own view without filters is the bare path', () => {
    expect(libraryHref({ view: 'own', filters: {} })).toBe('/library')
  })

  it.each(['out', 'borrowed', 'archive'] as const)('%s is ?view=%s', (view) => {
    expect(libraryHref({ view, filters: {} })).toBe(`/library?view=${view}`)
  })

  it('the own view carries its filters, and the other views never do', () => {
    expect(libraryHref({ view: 'own', filters: { q: 'Шантарам' } })).toBe(
      `/library?${new URLSearchParams({ q: 'Шантарам' }).toString()}`,
    )
    expect(libraryHref({ view: 'out', filters: { q: 'Шантарам' } })).toBe('/library?view=out')
  })

  it('what it writes is what readLibraryAddress reads back', () => {
    const address = { view: 'own', filters: { q: 'Шантарам', lang: 'uk' } } as const
    const href = libraryHref(address)
    const back = readLibraryAddress(new URLSearchParams(href.split('?')[1]))

    expect(back).toEqual({ ...address, valid: true })
  })
})

describe('filtersKey', () => {
  it('equal filters give equal keys, however the object was built', () => {
    expect(filtersKey({ q: 'a', lang: 'uk' })).toBe(filtersKey({ lang: 'uk', q: 'a' }))
    expect(filtersKey({})).toBe('')
  })
})

describe('isLibraryView', () => {
  it('accepts only the four views', () => {
    expect(isLibraryView('archive')).toBe(true)
    expect(isLibraryView('toString')).toBe(false)
    expect(isLibraryView('')).toBe(false)
  })
})

describe('libraryBookHref', () => {
  it('is the page of one copy, under /library', () => {
    expect(libraryBookHref('copy-1')).toBe('/library/copy-1')
  })

  it('escapes what would break the path', () => {
    expect(libraryBookHref('a/b c')).toBe('/library/a%2Fb%20c')
  })
})
