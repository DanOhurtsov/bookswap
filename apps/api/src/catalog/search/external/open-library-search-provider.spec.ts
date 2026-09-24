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

  async function search(limit = 5, query = 'тигролови') {
    return provider.search(query, limit, context())
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

  it('обрізає видачу до ліміту, навіть якщо провайдер віддав більше', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: Array.from({ length: 9 }, (_, index) => ({
          key: `/works/OL${String(index)}W`,
          title: `Книжка ${String(index)}`,
        })),
      }),
    )

    await expect(search(3, 'книжка')).resolves.toHaveLength(3)
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
