import type { ExternalSearchResult } from '@bookswap/shared'
import { ExternalSearchCache, externalSearchCacheKey } from './external-search.cache'

function result(id: string): ExternalSearchResult {
  return { id, kind: 'WORK', sources: ['OPEN_LIBRARY'], title: id }
}

describe('externalSearchCacheKey', () => {
  it('ігнорує регістр і зайві пробіли — це той самий запит', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', '  Тигролови   ', 10)).toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 10),
    )
  })

  it('розрізняє джерела', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 10)).not.toBe(
      externalSearchCacheKey('GOOGLE_BOOKS', 'тигролови', 10),
    )
  })

  it('розрізняє ліміти — відповідь на 10 записів не є відповіддю на 40', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 10)).not.toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 40),
    )
  })
})

describe('ExternalSearchCache', () => {
  let cache: ExternalSearchCache
  const ORIGINAL_TTL = process.env.CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS
  const ORIGINAL_MAX = process.env.CATALOG_EXTERNAL_SEARCH_CACHE_MAX_ENTRIES

  beforeEach(() => {
    cache = new ExternalSearchCache()
  })

  afterEach(() => {
    if (ORIGINAL_TTL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS = ORIGINAL_TTL

    if (ORIGINAL_MAX === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_CACHE_MAX_ENTRIES
    else process.env.CATALOG_EXTERNAL_SEARCH_CACHE_MAX_ENTRIES = ORIGINAL_MAX

    jest.useRealTimers()
  })

  it('другий запит за тим самим ключем не доходить до провайдера', async () => {
    const load = jest.fn().mockResolvedValue([result('a')])

    await cache.resolve('k', load)
    const second = await cache.resolve('k', load)

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toEqual([result('a')])
  })

  it('склеює ОДНОЧАСНІ однакові запити в один виклик провайдера', async () => {
    let release: (value: ExternalSearchResult[]) => void = () => undefined
    const load = jest.fn().mockReturnValue(
      new Promise<ExternalSearchResult[]>((resolve) => {
        release = resolve
      }),
    )

    const both = Promise.all([cache.resolve('k', load), cache.resolve('k', load)])
    release([result('a')])

    await expect(both).resolves.toEqual([[result('a')], [result('a')]])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('НЕ кешує помилку — ні як помилку, ні як порожню видачу', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('провайдер ліг'))
      .mockResolvedValueOnce([result('a')])

    await expect(cache.resolve('k', load)).rejects.toThrow('провайдер ліг')

    // The next attempt must reach the provider again: a source that was down
    // for ten seconds must not become "no such book" for an hour.
    await expect(cache.resolve('k', load)).resolves.toEqual([result('a')])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('після невдачі склеєні очікувачі теж отримують помилку, а не порожній список', async () => {
    const load = jest.fn().mockRejectedValue(new Error('провайдер ліг'))

    const settled = await Promise.allSettled([cache.resolve('k', load), cache.resolve('k', load)])

    // Both must REJECT: the second waiter must not receive an empty list just
    // because it coalesced onto somebody else's failed request.
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('прострочений запис іде до провайдера заново', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS = '1000'
    const load = jest.fn().mockResolvedValue([result('a')])
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now')

    clock.mockReturnValue(now)
    await cache.resolve('k', load)

    clock.mockReturnValue(now + 1001)
    await cache.resolve('k', load)

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('витісняє найдавніше використаний запис за LRU', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_CACHE_MAX_ENTRIES = '2'
    const load = jest.fn().mockImplementation(() => Promise.resolve([result('x')]))

    await cache.resolve('a', load)
    await cache.resolve('b', load)
    // Reading 'a' makes it the youngest, so 'b' is the one that must be evicted.
    await cache.resolve('a', load)
    await cache.resolve('c', load)

    expect(load).toHaveBeenCalledTimes(3)

    await cache.resolve('a', load)
    expect(load).toHaveBeenCalledTimes(3)

    await cache.resolve('b', load)
    expect(load).toHaveBeenCalledTimes(4)
  })
})
