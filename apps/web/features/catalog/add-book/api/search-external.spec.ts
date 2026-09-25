import type { ExternalSearchResult } from '@bookswap/shared'
import { CATALOG_LIMITS } from '@bookswap/shared'
import {
  DuplicateCheckFailedError,
  candidateQueryFor,
  findLocalDuplicates,
  searchExternalCatalogs,
} from './search-external'

jest.mock('@/app/lib/api', () => ({ apiRequest: jest.fn() }))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const EDITION: ExternalSearchResult = {
  id: 'GOOGLE_BOOKS:v1',
  kind: 'EDITION',
  sources: ['GOOGLE_BOOKS'],
  title: 'Тигролови',
  authors: ['Іван Багряний'],
  isbn13: '9786177585113',
}

const WORK: ExternalSearchResult = {
  id: 'OPEN_LIBRARY:OL1W',
  kind: 'WORK',
  sources: ['OPEN_LIBRARY'],
  title: 'Сад Гетсиманський',
  authors: ['Іван Багряний'],
  workExternalId: 'OL1W',
}

const candidate = { work: { id: 'work-1', title: 'Тигролови' } }

function queryOf(path: string): string {
  return decodeURIComponent(path.split('q=')[1] ?? '')
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('candidateQueryFor', () => {
  it('поєднує назву з першим автором', () => {
    expect(candidateQueryFor(EDITION)).toBe('Тигролови Іван Багряний')
  })

  it('без автора шукає лише за назвою — вигадувати автора не можна', () => {
    const { authors: _dropped, ...withoutAuthors } = EDITION

    expect(candidateQueryFor(withoutAuthors as ExternalSearchResult)).toBe('Тигролови')
  })
})

describe('searchExternalCatalogs', () => {
  it('звертається до власного бекенду, а не до провайдера напряму', async () => {
    mockApiRequest.mockResolvedValue({ results: [], sources: [], page: 1, hasMore: false })

    await searchExternalCatalogs('тигролови', 1, 10)

    const [path] = mockApiRequest.mock.calls[0] as [string]
    expect(path).toBe(
      '/catalog/search/external?q=%D1%82%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=1&pageSize=10',
    )
  })

  it('сторінка й розмір їдуть в запит явно — обидві половини списку питають те саме', async () => {
    mockApiRequest.mockResolvedValue({ results: [], sources: [], page: 3, hasMore: false })

    await searchExternalCatalogs('тигролови', 3, 50)

    const [path] = mockApiRequest.mock.calls[0] as [string]
    expect(path).toContain('&page=3&pageSize=50')
  })
})

describe('findLocalDuplicates', () => {
  it('за наявного ISBN перевіряє спершу його й не питає далі, якщо знайшов', async () => {
    const queries: string[] = []

    mockApiRequest.mockImplementation((path: string) => {
      queries.push(queryOf(path))

      return Promise.resolve({ candidates: [candidate] })
    })

    const check = await findLocalDuplicates(EDITION)

    expect(queries).toEqual(['9786177585113'])
    expect(check.matchedBy).toBe('ISBN')
    expect(check.candidates).toEqual([candidate])
  })

  it('коли за ISBN порожньо — пробує назву й автора', async () => {
    const queries: string[] = []

    mockApiRequest.mockImplementation((path: string) => {
      const query = queryOf(path)
      queries.push(query)

      return Promise.resolve({ candidates: query === '9786177585113' ? [] : [candidate] })
    })

    const check = await findLocalDuplicates(EDITION)

    expect(queries).toEqual(['9786177585113', 'Тигролови Іван Багряний'])
    // A title-only match is weaker evidence, and it is flagged differently.
    expect(check.matchedBy).toBe('TITLE')
  })

  it('запис без ISBN перевіряється лише за назвою й автором', async () => {
    const queries: string[] = []

    mockApiRequest.mockImplementation((path: string) => {
      queries.push(queryOf(path))

      return Promise.resolve({ candidates: [] })
    })

    const check = await findLocalDuplicates(WORK)

    expect(queries).toEqual(['Сад Гетсиманський Іван Багряний'])
    expect(check).toEqual({ candidates: [], matchedBy: undefined })
  })

  it('нічого не знайшлося — matchedBy лишається порожнім', async () => {
    mockApiRequest.mockResolvedValue({ candidates: [] })

    await expect(findLocalDuplicates(EDITION)).resolves.toEqual({
      candidates: [],
      matchedBy: undefined,
    })
  })

  it('не вигадує збіг, коли сам пошук кандидатів упав', async () => {
    mockApiRequest.mockRejectedValue(new Error('пошук недоступний'))

    // The error reaches the caller instead of posing as "no duplicates":
    // otherwise a failed check would quietly permit creating a duplicate.
    await expect(findLocalDuplicates(EDITION)).rejects.toThrow('пошук недоступний')
  })
})

/**
 * Regression: a title longer than `queryMax` used to fail `safeParse`, and the
 * failure was returned as an empty candidate list — indistinguishable from
 * "no duplicates", so the check was silently skipped.
 */
describe('довгі назви', () => {
  const longTitle = `${'Дуже довга назва '.repeat(20)}кінець`

  it('будує запит у межах контракту, зберігаючи початок назви', () => {
    const query = candidateQueryFor({
      id: 'GOOGLE_BOOKS:v1',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: longTitle,
      authors: ['Іван Багряний'],
    })

    expect(query.length).toBeLessThanOrEqual(CATALOG_LIMITS.queryMax)
    expect(query.length).toBeGreaterThanOrEqual(CATALOG_LIMITS.queryMin)
    expect(longTitle.startsWith(query)).toBe(true)
    // Cut on a word boundary, so the query never ends mid-word.
    expect(query.endsWith(' ')).toBe(false)
  })

  it('довга назва все одно доходить до пошуку кандидатів', async () => {
    const queries: string[] = []

    mockApiRequest.mockImplementation((path: string) => {
      queries.push(queryOf(path))

      return Promise.resolve({ candidates: [] })
    })

    await findLocalDuplicates({
      id: 'OPEN_LIBRARY:OL1W',
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: longTitle,
      authors: ['Іван Багряний'],
    })

    expect(queries).toHaveLength(1)
    expect(queries[0]?.length).toBeLessThanOrEqual(CATALOG_LIMITS.queryMax)
  })

  it('запит, який неможливо звести до контракту, кидає, а не вдає «дублікатів немає»', async () => {
    mockApiRequest.mockResolvedValue({ candidates: [] })

    // A one-character title cannot satisfy `queryMin`. Reporting that as an
    // empty result would let a duplicate through unchecked.
    await expect(
      findLocalDuplicates({
        id: 'OPEN_LIBRARY:OL2W',
        kind: 'WORK',
        sources: ['OPEN_LIBRARY'],
        title: 'A',
      }),
    ).rejects.toBeInstanceOf(DuplicateCheckFailedError)

    expect(mockApiRequest).not.toHaveBeenCalled()
  })
})
