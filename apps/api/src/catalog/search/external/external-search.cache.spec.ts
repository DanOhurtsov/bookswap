import type { ExternalSearchResult } from '@bookswap/shared'
import { ExternalSearchCache, externalSearchCacheKey } from './external-search.cache'
import type { ExternalSearchBlockResult } from './external-search-provider'

function result(id: string): ExternalSearchResult {
  return { id, kind: 'WORK', sources: ['OPEN_LIBRARY'], title: id }
}

/** The cached unit is a block, not a bare list — `exhausted` travels with it. */
function block(...ids: string[]): ExternalSearchBlockResult {
  return { results: ids.map(result), exhausted: true }
}

describe('externalSearchCacheKey', () => {
  it('ігнорує регістр і зайві пробіли — це той самий запит', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', '  Тигролови   ', 0, 10)).toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 0, 10),
    )
  })

  it('складає ключ із полів, розділених символом NUL', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'Тигролови', 2, 10)).toBe(
      ['OPEN_LIBRARY', '10', '2', 'тигролови'].join(String.fromCharCode(0)),
    )
  })

  it('розрізняє джерела', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 0, 10)).not.toBe(
      externalSearchCacheKey('GOOGLE_BOOKS', 'тигролови', 0, 10),
    )
  })

  it('розрізняє розміри блоку — відповідь на 10 записів не є відповіддю на 40', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 0, 10)).not.toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 0, 40),
    )
  })

  it('розрізняє блоки — друга порція стрічки не є першою', () => {
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 0, 10)).not.toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 1, 10),
    )
  })

  it('не плутає межу між частинами ключа', () => {
    // Без роздільника «блок 1, розмір 10» і «блок 11, розмір 0» злилися б в один
    // ключ, і сторінка віддавала б чужі записи.
    expect(externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 1, 10)).not.toBe(
      externalSearchCacheKey('OPEN_LIBRARY', 'тигролови', 11, 0),
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
    const load = jest.fn().mockResolvedValue(block('a'))

    await cache.resolve('k', load)
    const second = await cache.resolve('k', load)

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toEqual(block('a'))
  })

  it('peek бачить прочитаний блок і не бачить непрочитаного', async () => {
    const load = jest.fn().mockResolvedValue(block('a'))

    expect(cache.peek('k')).toBeUndefined()
    await cache.resolve('k', load)

    // Саме на цьому тримається «не більше одного звернення на запит»: блок, що
    // вже в руках, не коштує нічого, і сервіс має бачити це БЕЗ виклику до
    // провайдера.
    expect(cache.peek('k')).toEqual(block('a'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('peek не показує прострочений блок — несвіже не «в руках»', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_CACHE_TTL_MS = '1000'
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now')

    clock.mockReturnValue(now)
    await cache.resolve('k', jest.fn().mockResolvedValue(block('a')))

    clock.mockReturnValue(now + 1001)
    expect(cache.peek('k')).toBeUndefined()
  })

  it('склеює ОДНОЧАСНІ однакові запити в один виклик провайдера', async () => {
    let release: (value: ExternalSearchBlockResult) => void = () => undefined
    const load = jest.fn().mockReturnValue(
      new Promise<ExternalSearchBlockResult>((resolve) => {
        release = resolve
      }),
    )

    const both = Promise.all([cache.resolve('k', load), cache.resolve('k', load)])
    release(block('a'))

    await expect(both).resolves.toEqual([block('a'), block('a')])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('НЕ кешує помилку — ні як помилку, ні як порожню видачу', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('провайдер ліг'))
      .mockResolvedValueOnce(block('a'))

    await expect(cache.resolve('k', load)).rejects.toThrow('провайдер ліг')

    // The next attempt must reach the provider again: a source that was down
    // for ten seconds must not become "no such book" for an hour.
    await expect(cache.resolve('k', load)).resolves.toEqual(block('a'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('№5: неповний блок віддається, але не кешується', async () => {
    const partial = { ...block('a'), partialFailure: new Error('підзапит упав') }
    const load = jest.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(block('a'))

    await expect(cache.resolve('k', load)).resolves.toBe(partial)
    expect(cache.peek('k')).toBeUndefined()

    // Наступна спроба питає провайдера знову й уже кешує повну відповідь.
    await expect(cache.resolve('k', load)).resolves.toEqual(block('a'))
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.peek('k')).toEqual(block('a'))
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
    const load = jest.fn().mockResolvedValue(block('a'))
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
    const load = jest.fn().mockImplementation(() => Promise.resolve(block('x')))

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
