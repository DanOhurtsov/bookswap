import type { ExternalSearchContext } from './external-search-provider'
import { ExternalSearchProviderError } from './external-search-provider'
import { OpenLibrarySearchProvider } from './open-library-search-provider'

describe('OpenLibrarySearchProvider', () => {
  let fetchMock: jest.Mock
  let provider: OpenLibrarySearchProvider
  let acquired: number

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock
    provider = new OpenLibrarySearchProvider()
    acquired = 0
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response
  }

  function context(): ExternalSearchContext {
    return {
      signal: new AbortController().signal,
      acquire: async () => {
        acquired += 1
        return Promise.resolve()
      },
    }
  }

  /** A block of the stream; the tests below care about what survived the gate. */
  async function searchBlock(size = 5, query = 'тигролови', index = 0) {
    return provider.search(query, { index, size }, context())
  }

  async function search(size = 5, query = 'тигролови') {
    return (await searchBlock(size, query)).results
  }

  function sentQuery(): string {
    const [url] = fetchMock.mock.calls[0] as [URL]

    return url.searchParams.get('q') ?? ''
  }

  it('просить лише потрібні поля, тримає ліміт і надсилає ідентифікований User-Agent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search(7)

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.searchParams.get('limit')).toBe('7')
    // The provider asks us not to pull `*`; `isbn` is not requested at all here.
    expect(url.searchParams.get('fields')).not.toContain('*')
    expect(url.searchParams.get('fields')).not.toContain('isbn')
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('BookSwap')
  })

  it('віддає записи типу WORK і НІКОЛИ не бере ISBN з агрегованого списку видань', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            key: '/works/OL123W',
            title: 'Тигролови',
            author_name: ['Іван Багряний'],
            first_publish_year: 1944,
            language: ['ukr'],
            cover_i: 42,
            // Even when the aggregate does arrive it must be ignored: these are
            // the ISBNs of every printing of the work taken together.
            isbn: ['9789660303072', '9786177585113'],
          },
        ],
      }),
    )

    const [result] = await search()

    expect(result).toEqual({
      id: 'OPEN_LIBRARY:OL123W',
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: 'Тигролови',
      externalId: 'OL123W',
      workExternalId: 'OL123W',
      authors: ['Іван Багряний'],
      language: 'uk',
      firstPublishedYear: 1944,
      coverUrl: 'https://covers.openlibrary.org/b/id/42-M.jpg',
    })
    expect(result).not.toHaveProperty('isbn13')
    expect(result).not.toHaveProperty('publishedYear')
    expect(result).not.toHaveProperty('publisher')
  })

  it('розкодовує числові HTML-сутності в назві й імені автора', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            key: '/works/OL36836991W',
            title: '&#1047;&#1077;&#1084;&#1083;&#1103;... Зачем?',
            author_name: ['&#1040;&#1085; &#x426;&#x432;&#x435;&#x442;'],
          },
        ],
      }),
    )

    const [result] = await search(5, 'Земля')

    expect(result?.title).toBe('Земля... Зачем?')
    expect(result?.authors).toEqual(['Ан Цвет'])
  })

  it('лишає мову порожньою, коли твір має видання кількома мовами', async () => {
    // Запит збігається з назвою фікстури: ворота релевантності інакше
    // відкинули б документ ще до перевірки мови.
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            key: '/works/OL9W',
            title: 'Кобзар',
            language: ['ukr', 'eng', 'pol'],
          },
        ],
      }),
    )

    const [result] = await search(5, 'кобзар')

    // The first language in the list belongs to a random foreign printing,
    // not to this book.
    expect(result).not.toHaveProperty('language')
  })

  it('пропускає документи без назви або без розпізнаного /works/OL…W', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          { key: '/works/OL1W', title: '   ' },
          { key: '/books/OL2M', title: 'Видання, а не твір' },
          { key: '/works/OL3W', title: 'Придатний' },
        ],
      }),
    )

    const results = await search(5, 'придатний')

    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Придатний')
  })

  it('порожня видача — це порожній масив, а не помилка', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ numFound: 0, docs: [] }))

    await expect(search()).resolves.toEqual([])
  })

  it('HTTP-помилка кидає ExternalSearchProviderError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503))

    await expect(search()).rejects.toBeInstanceOf(ExternalSearchProviderError)
  })

  it('мережева помилка кидає ExternalSearchProviderError, а не «нічого не знайдено»', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    await expect(search()).rejects.toThrow('ECONNRESET')
  })

  // --- Блоки стрічки --------------------------------------------------------

  const docs = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => ({
      key: `/works/OL${String(from + index)}W`,
      title: `Книжка ${String(from + index)}`,
    }))

  it('зсуває offset на індекс блоку — це й робить пряме посилання на сторінку можливим', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [], numFound: 0 }))

    await searchBlock(24, 'книжка', 2)

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.get('limit')).toBe('24')
    // Зсув — чиста функція від номера блоку, без жодного курсора з попередньої
    // відповіді: інакше адреса ?page=3 не мала б звідки продовжити.
    expect(url.searchParams.get('offset')).toBe('48')
  })

  it('numFound каже, що стрічка скінчилася, ще до порожнього блоку', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ docs: docs(4, 8), numFound: 12, numFoundExact: true }),
    )

    await expect(searchBlock(4, 'книжка', 2)).resolves.toMatchObject({ exhausted: true })
  })

  it('коли попереду ще є документи, блок не вважається останнім', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ docs: docs(4, 0), numFound: 12, numFoundExact: true }),
    )

    await expect(searchBlock(4, 'книжка', 0)).resolves.toMatchObject({ exhausted: false })
  })

  it('коли numFound неточний, кінець стрічки впізнається за короткою відповіддю', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ docs: docs(2, 0), numFound: 500, numFoundExact: false }),
    )

    // Наближеному числу не вірять: коротка відповідь — це спостереження.
    await expect(searchBlock(4, 'книжка', 0)).resolves.toMatchObject({ exhausted: true })
  })

  it('блок, з якого ворота не пропустили нічого, НЕ виглядає кінцем стрічки', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: Array.from({ length: 4 }, (_, index) => ({
          key: `/works/OL${String(index)}W`,
          title: 'Зовсім інша книжка',
        })),
        numFound: 500,
        numFoundExact: true,
      }),
    )

    const block = await searchBlock(4, 'тигролови', 0)

    // Порожньо після воріт — і все одно є що читати далі: вичерпаність
    // рахується по СИРИХ документах, інакше один невдалий блок обрізав би пошук.
    expect(block.results).toEqual([])
    expect(block.exhausted).toBe(false)
  })

  // --- Поля пошуку ----------------------------------------------------------

  it('шукає крос-полем по назві й автору, а не вільним текстом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search()

    expect(sentQuery()).toBe('(title:"тигролови" OR author:"тигролови")')
  })

  it('кожне слово змішаного запиту шукається і в назві, і в авторі', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search(5, 'тигролови багряний')

    expect(sentQuery()).toBe(
      '(title:"тигролови" OR author:"тигролови") AND (title:"багряний" OR author:"багряний")',
    )
  })

  it('не вимагає цілого змішаного запиту як назви', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search(5, 'тигролови багряний')

    expect(sentQuery()).not.toContain('title:"тигролови багряний"')
  })

  it('зберігає «ї» та «й» — до провайдера йде те, що людина набрала', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search(5, 'Київ')

    expect(sentQuery()).toBe('(title:"Київ" OR author:"Київ")')
  })

  it('розділові знаки з запиту не потрапляють у мову запиту Solr', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    // Дужки й двокрапки у відповіді — це синтаксис Solr, який будуємо ми;
    // важливо, що всередині лапок опиняються самі слова, без лапок і двокрапок
    // користувача, які інакше розірвали б запит.
    await search(5, '«Тигролови»: роман')

    expect(sentQuery()).toBe(
      '(title:"Тигролови" OR author:"Тигролови") AND (title:"роман" OR author:"роман")',
    )
  })

  it('бере слот ліміту перед зверненням', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    await search()

    expect(acquired).toBe(1)
  })

  it('запит із самих розділових знаків не звертається до провайдера', async () => {
    await expect(search(5, '—  …')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // --- Ворота релевантності -------------------------------------------------

  it('відкидає документ, назва й автори якого не кажуть нічого із запиту', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            key: '/works/OL77W',
            title: 'Українська література. 9 клас: Плани-конспекти уроків',
            author_name: ['В. В. Паращич'],
          },
        ],
      }),
    )

    await expect(search()).resolves.toEqual([])
  })

  it('пропускає збіг лише за автором', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [{ key: '/works/OL78W', title: 'Розгром', author_name: ['Іван Багряний'] }],
      }),
    )

    await expect(search(5, 'багряний')).resolves.toHaveLength(1)
  })
})
