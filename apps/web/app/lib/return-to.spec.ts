import { returnToQuery, safeReturnTo } from './return-to'

describe('safeReturnTo', () => {
  it('accepts exactly /invite', () => {
    expect(safeReturnTo('/invite')).toBe('/invite')
  })

  it.each([
    '//evil.example',
    'https://evil.example/invite',
    '/profile?x=1',
    '/invite/../x',
    '/invite?x=1',
    '/invite#t',
    '\\invite',
    '/\\evil.example',
    '',
    ' /invite',
    '/library',
  ])('rejects %j and falls back', (value) => {
    expect(safeReturnTo(value)).toBe('/profile')
  })

  it('falls back for missing values and honours a custom fallback', () => {
    expect(safeReturnTo(null)).toBe('/profile')
    expect(safeReturnTo(undefined, '/x')).toBe('/x')
  })
})

describe('returnToQuery', () => {
  it('keeps only an allowed target', () => {
    expect(returnToQuery('/invite')).toBe('?returnTo=%2Finvite')
    expect(returnToQuery('//evil')).toBe('')
    expect(returnToQuery(null)).toBe('')
  })
})
