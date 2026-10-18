import { DEFAULT_SEARCH_PAGE_SIZE, SEARCH_MAX_PAGE } from '@bookswap/shared'
import {
  askedFor,
  knownPageLinks,
  nextPageOf,
  pageFromParam,
  pageSizeFromParam,
  readSearchAddress,
  searchHref,
} from './search-page'

describe('pageFromParam', () => {
  it('адреса без page — це перша сторінка, а не помилка', () => {
    expect(pageFromParam(null)).toBe(1)
    expect(pageFromParam('')).toBe(1)
  })

  it('читає номер сторінки з адреси', () => {
    expect(pageFromParam('3')).toBe(3)
  })

  it.each(['0', '-1', 'abc', '2.5', String(SEARCH_MAX_PAGE + 1)])(
    'page=%s — це не сторінка, і мовчки першою воно не стає',
    (raw) => {
      expect(pageFromParam(raw)).toBeUndefined()
    },
  )

  it('тримає ту саму межу, що й сервер — запиту, який дасть 400, не буде', () => {
    expect(pageFromParam(String(SEARCH_MAX_PAGE))).toBe(SEARCH_MAX_PAGE)
  })
})

describe('pageSizeFromParam', () => {
  it('без параметра — типовий розмір', () => {
    expect(pageSizeFromParam(null)).toBe(DEFAULT_SEARCH_PAGE_SIZE)
  })

  it.each(['12', '24', '36', '48'])('приймає %s', (raw) => {
    expect(pageSizeFromParam(raw)).toBe(Number(raw))
  })

  // 10, 20 і 50 — колишні розміри.
  it.each(['0', '5', '10', '15', '20', '50', '100', 'abc'])('%s — не розмір сторінки', (raw) => {
    expect(pageSizeFromParam(raw)).toBeUndefined()
  })
})

describe('readSearchAddress', () => {
  it('читає q, page і pageSize', () => {
    expect(readSearchAddress(new URLSearchParams('q=тигр&page=3&pageSize=24'))).toEqual({
      q: 'тигр',
      page: 3,
      pageSize: 24,
      valid: true,
    })
  })

  it('без page і pageSize — перша сторінка типового розміру, і адреса допустима', () => {
    expect(readSearchAddress(new URLSearchParams('q=тигр'))).toEqual({
      q: 'тигр',
      page: 1,
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
      valid: true,
    })
  })

  // 10, 20 і 50 — колишні розміри. Сторінка 3 зі старим розміром — не сторінка 3 нового: пара
  // page/pageSize має сенс лише разом, тож скидається цілком, а не лише розмір.
  it.each(['10', '20', '50'])(
    'стара адреса page=3&pageSize=%s — перша сторінка типового розміру, запит той самий',
    (raw) => {
      expect(readSearchAddress(new URLSearchParams(`q=тигр&page=3&pageSize=${raw}`))).toEqual({
        q: 'тигр',
        page: 1,
        pageSize: DEFAULT_SEARCH_PAGE_SIZE,
        valid: false,
      })
    },
  )

  it.each(['abc', '0', '999'])(
    'недопустимий page=%s з допустимим pageSize=24 — та сама пара 1 і типовий розмір',
    (raw) => {
      expect(readSearchAddress(new URLSearchParams(`q=тигр&page=${raw}&pageSize=24`))).toEqual({
        q: 'тигр',
        page: 1,
        pageSize: DEFAULT_SEARCH_PAGE_SIZE,
        valid: false,
      })
    },
  )

  it('недопустимий розмір без page — та сама нормалізована пара', () => {
    expect(readSearchAddress(new URLSearchParams('q=x&pageSize=7'))).toEqual({
      q: 'x',
      page: 1,
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
      valid: false,
    })
  })
})

describe('searchHref', () => {
  const none = new URLSearchParams()

  it('канонічна адреса мінімальна: без page=1 і без типового pageSize=12', () => {
    expect(searchHref('/catalog', none, { q: 'Тигр', page: 1, pageSize: 12 })).toBe(
      '/catalog?q=%D0%A2%D0%B8%D0%B3%D1%80',
    )
  })

  it('глибша сторінка й нетиповий розмір їдуть в адресі', () => {
    expect(searchHref('/catalog', none, { q: 'a b', page: 2, pageSize: 48 })).toBe(
      '/catalog?q=a+b&page=2&pageSize=48',
    )
  })

  it('екранує запит — інакше «&» у назві розірвав би адресу', () => {
    expect(searchHref('/catalog', none, { q: 'Ніч & день', page: 2, pageSize: 12 })).toContain(
      '%26',
    )
  })

  it('переносить параметри сторінки додавання, окрім названих у drop', () => {
    const current = new URLSearchParams('q=old&page=4&mode=scan&workId=w1&external=tok')

    expect(searchHref('/catalog/new', current, { q: 'new', page: 1, pageSize: 24 })).toBe(
      '/catalog/new?q=new&pageSize=24&mode=scan&workId=w1&external=tok',
    )
    expect(
      searchHref('/catalog/new', current, { q: 'new', page: 1, pageSize: 24 }, ['external']),
    ).toBe('/catalog/new?q=new&pageSize=24&mode=scan&workId=w1')
  })
})

describe('askedFor', () => {
  it('відповідь на іншу сторінку чи розмір того самого запиту — інша відповідь', () => {
    expect(askedFor('тигролови', 1, 10)).not.toBe(askedFor('тигролови', 2, 10))
    expect(askedFor('тигролови', 1, 10)).not.toBe(askedFor('тигролови', 1, 20))
  })

  it('межу між частинами не можна підробити текстом запиту', () => {
    expect(askedFor('2тигролови', 1, 10)).not.toBe(askedFor('тигролови', 12, 10))
    expect(askedFor('0тигролови', 1, 1)).not.toBe(askedFor('тигролови', 1, 10))
  })
})

describe('nextPageOf', () => {
  it('локальне «є ще» або зовнішнє YES — доказ', () => {
    expect(nextPageOf({ page: 1, localHasMore: true, externalMore: 'NO' })).toBe('PROVEN')
    expect(nextPageOf({ page: 1, localHasMore: false, externalMore: 'YES' })).toBe('PROVEN')
  })

  it('UNKNOWN — «Далі» можливе, але не доведене', () => {
    expect(nextPageOf({ page: 1, localHasMore: false, externalMore: 'UNKNOWN' })).toBe('POSSIBLE')
  })

  it('NO без локальних — наступної немає', () => {
    expect(nextPageOf({ page: 1, localHasMore: false, externalMore: 'NO' })).toBe('NONE')
  })

  it('на максимальній сторінці наступної немає, хоч би що казали джерела (регресія №4)', () => {
    for (const externalMore of ['YES', 'NO', 'UNKNOWN'] as const) {
      expect(nextPageOf({ page: SEARCH_MAX_PAGE, localHasMore: true, externalMore })).toBe('NONE')
    }
  })
})

describe('knownPageLinks', () => {
  it('перша сторінка без доказу наступної — лише 1', () => {
    expect(knownPageLinks({ page: 1, currentHasRows: true, next: 'NONE' })).toEqual([1])
  })

  it('доведена наступна дає номер, можлива — ні', () => {
    expect(knownPageLinks({ page: 1, currentHasRows: true, next: 'PROVEN' })).toEqual([1, 2])
    expect(knownPageLinks({ page: 1, currentHasRows: true, next: 'POSSIBLE' })).toEqual([1])
  })

  it('середня сторінка: перша, розрив, попередня, поточна, наступна', () => {
    expect(knownPageLinks({ page: 6, currentHasRows: true, next: 'PROVEN' })).toEqual([
      1,
      'gap',
      5,
      6,
      7,
    ])
  })

  it('порожня поточна сторінка не доводить існування попередніх', () => {
    expect(knownPageLinks({ page: 5, currentHasRows: false, next: 'NONE' })).toEqual([1, 5])
  })

  it('без розриву, коли попередня — друга', () => {
    expect(knownPageLinks({ page: 3, currentHasRows: true, next: 'NONE' })).toEqual([1, 2, 3])
  })
})
