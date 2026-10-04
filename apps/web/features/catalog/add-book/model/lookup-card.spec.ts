import type { AddSearchEditionItem, AddSearchExternalItem, AddSearchItem } from '@bookswap/shared'
import { lookupCardIsRedundant } from './lookup-card'

const ISBN = '9783161484100'

function localEdition(isbn13: string | null): AddSearchEditionItem {
  return {
    kind: 'EDITION',
    key: 'edition:e-1',
    edition: {
      id: 'e-1',
      workId: 'w-1',
      translationId: null,
      textKind: 'UNKNOWN',
      publisher: null,
      year: null,
      isbn13,
      pageCount: null,
      coverUrl: null,
      format: null,
      lang: null,
      translator: null,
      revision: 1,
    },
    work: {
      id: 'w-1',
      title: 'Книжка',
      origLang: null,
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
    matchedOn: 'ISBN',
    ownership: { activeCount: 0, archivedCount: 0 },
  }
}

function externalRecord(isbn13?: string): AddSearchExternalItem {
  return {
    kind: 'EXTERNAL',
    key: 'external:GOOGLE_BOOKS:v',
    result: {
      id: 'GOOGLE_BOOKS:v',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: 'Зовнішня',
      ...(isbn13 === undefined ? {} : { isbn13 }),
    },
  }
}

describe('lookupCardIsRedundant — одне видання не показується двічі', () => {
  it('порожні половини: картка точного ISBN потрібна', () => {
    expect(lookupCardIsRedundant(ISBN, [], [])).toBe(false)
  })

  it('те саме видання вже серед місцевих результатів', () => {
    expect(lookupCardIsRedundant(ISBN, [localEdition(ISBN)], [])).toBe(true)
  })

  it('те саме видання серед зовнішніх: зовнішній запис із таким ISBN', () => {
    expect(lookupCardIsRedundant(ISBN, [], [externalRecord(ISBN)])).toBe(true)
  })

  it('наше видання, підставлене сервером у зовнішню половину', () => {
    expect(lookupCardIsRedundant(ISBN, [], [localEdition(ISBN)])).toBe(true)
  })

  it('інші ISBN чи записи без ISBN картку не прибирають', () => {
    const other: AddSearchItem[] = [localEdition('9780306406157'), localEdition(null)]

    expect(
      lookupCardIsRedundant(ISBN, other, [externalRecord('9780306406157'), externalRecord()]),
    ).toBe(false)
  })
})
