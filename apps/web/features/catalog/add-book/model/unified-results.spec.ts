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
  it('складає локальні й зовнішні записи в ОДИН список', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [candidate({ id: 'work-1', title: 'Тигролови' })],
      [external({ id: 'GOOGLE_BOOKS:v1' })],
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.origin).sort()).toEqual(['EXTERNAL', 'LOCAL'])
  })

  it('локальні результати доступні й до приходу зовнішніх', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [candidate({ id: 'work-1', title: 'Тигролови' })],
      [],
    )

    expect(keysOf(rows)).toEqual(['local:work-1'])
  })

  it('сортує за релевантністю, а не за походженням', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [candidate({ id: 'work-1', title: 'Зовсім інша книжка', authors: ['Хтось'] })],
      [external({ id: 'GOOGLE_BOOKS:v1', title: 'Тигролови' })],
    )

    // Точна назва ззовні випереджає слабкий локальний збіг: спільний список
    // існує саме для того, щоб релевантність важила більше за джерело.
    expect(keysOf(rows)[0]).toBe('external:GOOGLE_BOOKS:v1')
  })

  it('за однакової релевантності попереду наш каталог', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [candidate({ id: 'work-1', title: 'Тигролови' })],
      [external({ id: 'GOOGLE_BOOKS:v1', title: 'Тигролови' })],
    )

    expect(keysOf(rows)).toEqual(['local:work-1', 'external:GOOGLE_BOOKS:v1'])
  })

  it('точний збіг назви вище за частковий у межах спільного списку', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [],
      [
        external({ id: 'GOOGLE_BOOKS:long', title: 'Тигролови та інші повісті' }),
        external({ id: 'GOOGLE_BOOKS:exact', title: 'Тигролови' }),
      ],
    )

    expect(keysOf(rows)).toEqual(['external:GOOGLE_BOOKS:exact', 'external:GOOGLE_BOOKS:long'])
  })

  // --- Дедуплікація ---------------------------------------------------------

  it('ховає зовнішній запис із ISBN, який уже є в нашому каталозі', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [
        candidate({
          id: 'work-1',
          title: 'Тигролови',
          editions: [edition({ id: 'edition-1', isbn13: '9786177585113' })],
        }),
      ],
      [external({ id: 'GOOGLE_BOOKS:v1', isbn13: '9786177585113' })],
    )

    expect(keysOf(rows)).toEqual(['local:work-1'])
  })

  it('інший ISBN — це інше видання, і воно лишається в списку', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [
        candidate({
          id: 'work-1',
          title: 'Тигролови',
          editions: [edition({ id: 'edition-1', isbn13: '9786177585113' })],
        }),
      ],
      [external({ id: 'GOOGLE_BOOKS:v1', isbn13: '9789660303072' })],
    )

    expect(rows).toHaveLength(2)
  })

  it('однакова назва без ISBN не вважається дублікатом', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [candidate({ id: 'work-1', title: 'Тигролови' })],
      [external({ id: 'GOOGLE_BOOKS:v1', title: 'Тигролови' })],
    )

    // Тезки бувають, а два тиражі — це дві різні книжки на полиці.
    expect(rows).toHaveLength(2)
  })

  it('зовнішній запис без ISBN лишається, навіть коли в каталозі є ISBN', () => {
    const rows = buildUnifiedResults(
      'Тигролови',
      [
        candidate({
          id: 'work-1',
          title: 'Тигролови',
          editions: [edition({ id: 'edition-1', isbn13: '9786177585113' })],
        }),
      ],
      [external({ id: 'OPEN_LIBRARY:OL1W', kind: 'WORK', sources: ['OPEN_LIBRARY'] })],
    )

    expect(rows).toHaveLength(2)
  })
})
