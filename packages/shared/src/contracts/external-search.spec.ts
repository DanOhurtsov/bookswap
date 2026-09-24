import {
  externalSearchResponseSchema,
  externalSearchResultSchema,
  externalSearchResultToLookup,
  type ExternalSearchResult,
} from './external-search'
import { bookLookupResultSchema } from './lookup'

const WORK: ExternalSearchResult = {
  id: 'OPEN_LIBRARY:OL1W',
  kind: 'WORK',
  sources: ['OPEN_LIBRARY'],
  title: 'Тигролови',
  authors: ['Іван Багряний'],
  firstPublishedYear: 1944,
  language: 'uk',
  coverUrl: 'https://covers.openlibrary.org/b/id/42-M.jpg',
  workExternalId: 'OL1W',
  externalId: 'OL1W',
}

const EDITION: ExternalSearchResult = {
  id: 'GOOGLE_BOOKS:v1',
  kind: 'EDITION',
  sources: ['GOOGLE_BOOKS'],
  title: 'Тигролови',
  authors: ['Іван Багряний'],
  isbn13: '9786177585113',
  publishedYear: 2019,
  publisher: 'Смолоскип',
  pageCount: 304,
  language: 'uk',
  externalId: 'v1',
}

describe('externalSearchResultSchema', () => {
  it('приймає запис про твір без ISBN — це нормальний результат, а не неповний', () => {
    expect(externalSearchResultSchema.parse(WORK)).toEqual(WORK)
  })

  it('приймає видання без ISBN', () => {
    const { isbn13: _dropped, ...withoutIsbn } = EDITION

    expect(externalSearchResultSchema.safeParse(withoutIsbn).success).toBe(true)
  })

  it.each(['isbn13', 'publisher', 'publishedYear', 'pageCount'] as const)(
    'відхиляє поле видання «%s» на записі про твір',
    (field) => {
      const invalid = { ...WORK, [field]: field === 'isbn13' ? '9786177585113' : 2019 }

      const parsed = externalSearchResultSchema.safeParse(invalid)

      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues[0]?.path).toEqual([field])
    },
  )

  it('дозволяє рік першої публікації на EDITION — це наслідок злиття з записом про твір', () => {
    const mergedPrinting = { ...EDITION, firstPublishedYear: 1944 }

    // `firstPublishedYear` is work-level, so it is not an edition-only field:
    // a printing merged with its work record legitimately carries both years.
    expect(externalSearchResultSchema.safeParse(mergedPrinting).success).toBe(true)
  })

  it('відхиляє невалідний ISBN-13', () => {
    expect(
      externalSearchResultSchema.safeParse({ ...EDITION, isbn13: '9786177585119' }).success,
    ).toBe(false)
  })

  it('вимагає щонайменше одне джерело', () => {
    expect(externalSearchResultSchema.safeParse({ ...EDITION, sources: [] }).success).toBe(false)
  })
})

describe('externalSearchResponseSchema', () => {
  it('несе статус кожного опитаного джерела, включно з тим, що впало', () => {
    const parsed = externalSearchResponseSchema.parse({
      results: [],
      sources: [
        { source: 'OPEN_LIBRARY', status: 'ERROR' },
        { source: 'GOOGLE_BOOKS', status: 'TIMEOUT' },
      ],
    })

    expect(parsed.sources).toHaveLength(2)
  })

  it('розрізняє власне обмеження частоти й збій провайдера', () => {
    const parsed = externalSearchResponseSchema.parse({
      results: [],
      sources: [{ source: 'OPEN_LIBRARY', status: 'RATE_LIMITED' }],
    })

    expect(parsed.sources[0]?.status).toBe('RATE_LIMITED')
  })

  it('не приймає більше за EXTERNAL_SEARCH_LIMIT результатів', () => {
    const results = Array.from({ length: 13 }, (_, index) => ({
      ...EDITION,
      id: `GOOGLE_BOOKS:v${String(index)}`,
    }))

    expect(externalSearchResponseSchema.safeParse({ results, sources: [] }).success).toBe(false)
  })
})

describe('externalSearchResultToLookup', () => {
  it('переносить у чернетку форми поля видання', () => {
    expect(externalSearchResultToLookup(EDITION)).toEqual({
      title: 'Тигролови',
      authors: ['Іван Багряний'],
      language: 'uk',
      publishedYear: 2019,
      publisher: 'Смолоскип',
      pageCount: 304,
      source: 'GOOGLE_BOOKS',
      externalId: 'v1',
    })
  })

  it('НЕ перетворює рік першої публікації твору на рік видання', () => {
    const lookup = externalSearchResultToLookup(WORK)

    // `BookLookupResult.publishedYear` means `Edition.year`. Putting 1944 there
    // would tell the user they are holding a first edition. The work-level year
    // reaches `Work.firstPubYear` through `newWorkFromExternal` instead.
    expect(lookup).not.toHaveProperty('publishedYear')
    expect(lookup).not.toHaveProperty('firstPublishedYear')
    expect(lookup).toMatchObject({
      title: 'Тигролови',
      authors: ['Іван Багряний'],
      language: 'uk',
      workExternalId: 'OL1W',
    })
  })

  it('результат завжди проходить контракт lookup — це та сама чернетка форми', () => {
    expect(bookLookupResultSchema.safeParse(externalSearchResultToLookup(WORK)).success).toBe(true)
    expect(bookLookupResultSchema.safeParse(externalSearchResultToLookup(EDITION)).success).toBe(
      true,
    )
  })
})
