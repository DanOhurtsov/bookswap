import { readFileSync } from 'node:fs'
import type { LibraryImportRowValues } from '@bookswap/shared'
import { sameBook } from './library-import.service'

const base = { isbn13: '9780306406157', title: 'T', origLang: 'uk' } as LibraryImportRowValues
const withAuthors = (authors: string[]): LibraryImportRowValues => ({ ...base, authors })

describe('sameBook — authors are compared as a list, not as joined text', () => {
  it('one author with a space differs from two authors', () => {
    expect(sameBook(withAuthors(['Іван Франко']), withAuthors(['Іван', 'Франко']))).toBe(false)
  })

  it('the same list is the same book', () => {
    expect(sameBook(withAuthors(['А', 'Б']), withAuthors(['А', 'Б']))).toBe(true)
  })

  it('the source contains no raw NUL byte', () => {
    const source = readFileSync(`${__dirname}/library-import.service.ts`)

    expect(source.includes(0)).toBe(false)
  })
})
