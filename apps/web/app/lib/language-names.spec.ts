import { LANGUAGE_CODES } from '@bookswap/shared'
import { languageName } from './language-names'

describe('languageName', () => {
  it('names every ISO 639-1 code in Ukrainian, not by its code', () => {
    const unnamed = LANGUAGE_CODES.filter((code) => languageName(code) === code)

    expect(unnamed).toEqual([])
  })

  it('gives every code its own name: a list of languages has no two equal entries', () => {
    const names = LANGUAGE_CODES.map(languageName)

    expect(new Set(names).size).toBe(names.length)
  })

  it('returns an unknown code as is rather than inventing a name', () => {
    expect(languageName('uk')).toBe('українська')
    expect(languageName('zz')).toBe('zz')
  })
})
