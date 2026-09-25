import type { Edition, ExternalSearchResult, WorkDetailResponse } from '@bookswap/shared'
import { buildUnifiedResults } from './unified-results'

function edition(overrides: Partial<Edition> & { id: string }): Edition {
  return {
    workId: 'work-1',
    translationId: null,
    publisher: 'Смолоскип',
    year: 2019,
    isbn13: null,
    pageCount: 320,
    coverUrl: null,
    format: 'HARDCOVER',
    lang: 'uk',
    translator: null,
    revision: 1,
    ...overrides,
  }
}

function candidate(overrides: {
  id: string
  title: string
  authors?: string[]
  editions?: Edition[]
}): WorkDetailResponse {
  return {
    work: {
      id: overrides.id,
      title: overrides.title,
      origLang: 'uk',
      firstPubYear: 1944,
      description: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: (overrides.authors ?? ['Іван Багряний']).map((name, position) => ({
      id: `author-${String(position)}`,
      name,
      nameLatin: null,
      role: 'AUTHOR' as const,
      position,
    })),
    translations: [],
    editions: overrides.editions ?? [],
  }
}

function external(overrides: Partial<ExternalSearchResult> & { id: string }): ExternalSearchResult {
  return {
    kind: 'EDITION',
    sources: ['GOOGLE_BOOKS'],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    ...overrides,
  }
}

const keysOf = (rows: ReturnType<typeof buildUnifiedResults>) => rows.map((row) => row.key)

describe('buildUnifiedResults', () => {
  it('локальні рядки йдуть першими, зовнішні — за ними, у порядку сервера', () => {
    const rows = buildUnifiedResults(
      [candidate({ id: 'w1', title: 'Розгром' }), candidate({ id: 'w2', title: 'Сад' })],
      [external({ id: 'GOOGLE_BOOKS:b' }), external({ id: 'GOOGLE_BOOKS:a' })],
    )

    expect(keysOf(rows)).toEqual([
      'local:w1',
      'local:w2',
      'external:GOOGLE_BOOKS:b',
      'external:GOOGLE_BOOKS:a',
    ])
  })

  it('не пересортовує за релевантністю: межі сторінок різала сервер за цим порядком', () => {
    const rows = buildUnifiedResults(
      [candidate({ id: 'w1', title: 'Зовсім інша назва' })],
      [external({ id: 'GOOGLE_BOOKS:exact', title: 'Тигролови' })],
    )

    expect(keysOf(rows)).toEqual(['local:w1', 'external:GOOGLE_BOOKS:exact'])
  })

  it('не відкидає зовнішній запис із ISBN нашого каталогу — це робить сервер до нарізання', () => {
    const rows = buildUnifiedResults(
      [
        candidate({
          id: 'w1',
          title: 'Тигролови',
          editions: [edition({ id: 'e1', isbn13: '9786177585113' })],
        }),
      ],
      [external({ id: 'GOOGLE_BOOKS:x', isbn13: '9786177585113' })],
    )

    expect(keysOf(rows)).toHaveLength(2)
  })

  it('порожній вхід — порожній список', () => {
    expect(buildUnifiedResults([], [])).toEqual([])
  })
})
