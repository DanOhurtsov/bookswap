import type { ExternalSearchContext } from './external-search-provider'
import { ExternalSearchProviderError } from './external-search-provider'
import { GoogleBooksSearchProvider } from './google-books-search-provider'

describe('GoogleBooksSearchProvider', () => {
  let fetchMock: jest.Mock
  let provider: GoogleBooksSearchProvider
  let previousApiKey: string | undefined
  let acquired: number

  beforeEach(() => {
    previousApiKey = process.env.GOOGLE_BOOKS_API_KEY
    delete process.env.GOOGLE_BOOKS_API_KEY
    fetchMock = jest.fn()
    global.fetch = fetchMock
    provider = new GoogleBooksSearchProvider()
    acquired = 0
  })

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY
    else process.env.GOOGLE_BOOKS_API_KEY = previousApiKey
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

  async function search(query = 'тигролови', limit = 5) {
    return provider.search(query, limit, context())
  }

  /** The `q` of the n-th outbound call. */
  function sentQuery(call: number): string {
    const [url] = fetchMock.mock.calls[call] as [URL]

    return url.searchParams.get('q') ?? ''
  }

  const volume = (id: string, volumeInfo: Record<string, unknown>) => ({ id, volumeInfo })

  it('передає серверний ключ у запит і ніколи не повертає його в результаті', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'server-secret'
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    const results = await search()

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.get('key')).toBe('server-secret')
    expect(JSON.stringify(results)).not.toContain('server-secret')
  })

  it('без ключа запит усе одно надсилається, просто без параметра key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search()

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.has('key')).toBe(false)
  })

  it('не просить у провайдера більше за документований максимум maxResults', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови', 200)

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.get('maxResults')).toBe('40')
  })

  // --- Поля пошуку ----------------------------------------------------------

  it('шукає за назвою через intitle, а не повним текстом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [volume('v', { title: 'Тигролови' })] }))

    await search()

    expect(sentQuery(0)).toBe('intitle:"тигролови"')
  })

  it('кожне слово отримує власний intitle — інакше зв’язується лише перше', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [volume('v', { title: 'Українська література' })] }),
    )

    await search('українська література')

    expect(sentQuery(0)).toBe('intitle:"українська" intitle:"література"')
  })

  it('зберігає символи запиту як є — не згортає «ї» та «й»', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [volume('v', { title: 'Київ' })] }))

    await search('Київ')

    expect(sentQuery(0)).toBe('intitle:"Київ"')
  })

  it('розділові знаки не потрапляють у мову запиту провайдера', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('«Тигролови»: роман')

    expect(sentQuery(0)).toBe('intitle:"Тигролови" intitle:"роман"')
  })

  it('змішаний запит не йде цілком як обов’язкова назва', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови багряний')

    expect(sentQuery(0)).not.toContain('intitle:"тигролови багряний"')
  })

  it('пробує КОЖНЕ слово як автора, без огляду на позицію', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови багряний')

    const sent = fetchMock.mock.calls.map((_, index) => sentQuery(index))
    expect(sent).toContain('inauthor:"тигролови"')
    expect(sent).toContain('inauthor:"багряний"')
  })

  it('однаковий план для «назва автор» і «автор назва»', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови багряний')
    const forward = fetchMock.mock.calls.map((_, index) => sentQuery(index)).sort()

    fetchMock.mockClear()
    await search('багряний тигролови')
    const backward = fetchMock.mock.calls.map((_, index) => sentQuery(index)).sort()

    // Запити за автором не залежать від позиції слова — саме тому «Багряний
    // Тигролови» знаходиться так само, як «Тигролови Багряний». Запит за
    // назвою лишається у введеному порядку, бо назва — це фраза.
    const authorProbes = (queries: string[]) => queries.filter((q) => q.startsWith('inauthor:'))

    expect(authorProbes(backward)).toEqual(authorProbes(forward))
    expect(backward).toHaveLength(forward.length)
  })

  it('запит за автором сам по собі покриває змішаний — решту доберуть ворота', async () => {
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(
        url.searchParams.get('q') === 'inauthor:"багряний"'
          ? jsonResponse({
              items: [
                volume('right', { title: 'Тигролови', authors: ['Іван Багряний'] }),
                volume('other', { title: 'Розгром', authors: ['Іван Багряний'] }),
              ],
            })
          : jsonResponse({ totalItems: 0 }),
      ),
    )

    const results = await search('тигролови багряний')

    // «Розгром» того самого автора не проходить: слова «тигролови» немає
    // ні в назві, ні в авторах.
    expect(results.map((result) => result.title)).toEqual(['Тигролови'])
  })

  it('для одного слова план завжди містить пошук за автором', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ totalItems: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [volume('v', { title: 'Розгром', authors: ['Іван Багряний'] })] }),
      )

    const results = await search('багряний')

    expect(sentQuery(1)).toBe('inauthor:"багряний"')
    expect(results.map((result) => result.title)).toEqual(['Розгром'])
  })

  it('жоден із запитів не є повнотекстовим', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови багряний')

    for (const call of fetchMock.mock.calls.keys()) {
      expect(sentQuery(call)).toMatch(/^(intitle:|inauthor:)/u)
    }
  })

  it('збіг у назві НЕ скасовує пошуку за автором', async () => {
    // Регресія: «Багряний» — і прізвище, і назва книжок про нього. План, що
    // спинявся на першій непорожній відповіді, віддавав самі біографії й
    // ніколи не питав про романи самого автора.
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(
        url.searchParams.get('q') === 'intitle:"багряний"'
          ? jsonResponse({ items: [volume('bio', { title: 'Іван Багряний', authors: ['Шугай'] })] })
          : jsonResponse({
              items: [volume('novel', { title: 'Тигролови', authors: ['Іван Багряний'] })],
            }),
      ),
    )

    const results = await search('багряний')

    expect(fetchMock.mock.calls.map((_, index) => sentQuery(index))).toEqual([
      'intitle:"багряний"',
      'inauthor:"багряний"',
    ])
    expect(results.map((result) => result.title)).toEqual(['Іван Багряний', 'Тигролови'])
  })

  it('бюджет запитів обмежений навіть для довгого запиту', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('гаррі поттер і келих вогню ролінг')

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('пробує найдовші слова — сполучники не витрачають бюджету', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('гаррі поттер і келих вогню ролінг')

    const sent = fetchMock.mock.calls.map((_, index) => sentQuery(index))
    expect(sent).not.toContain('inauthor:"і"')
  })

  it('невдача одного запиту не забирає результатів іншого', async () => {
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(
        url.searchParams.get('q') === 'intitle:"тигролови"'
          ? jsonResponse({ items: [volume('v', { title: 'Тигролови' })] })
          : jsonResponse({}, 429),
      ),
    )

    await expect(search()).resolves.toHaveLength(1)
  })

  it('якщо не вдався жоден запит — це помилка, а не «нічого не знайдено»', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429))

    await expect(search()).rejects.toBeInstanceOf(ExternalSearchProviderError)
  })

  it('не дублює той самий том, знайдений двома запитами', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [volume('same', { title: 'Тигролови', authors: ['Тигролови'] })] }),
    )

    await expect(search()).resolves.toHaveLength(1)
  })

  it('бере слот ліміту перед КОЖНИМ зверненням', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await search('тигролови багряний')

    expect(acquired).toBe(fetchMock.mock.calls.length)
  })

  it('запит із самих розділових знаків не звертається до провайдера взагалі', async () => {
    await expect(search('—  …')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // --- Ворота релевантності -------------------------------------------------

  it('відкидає том, де запит трапляється лише в описі', async () => {
    // Саме це псувало видачу: `intitle:` для Google — підказка ранжування, а не
    // фільтр, тож підручник із згадкою роману в тексті доходив до користувача.
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          volume('textbook', {
            title: 'Українська література. 11 клас. Плани-конспекти',
            authors: ['В. В. Паращич'],
            description: 'Розробки уроків за романом «Тигролови» Івана Багряного.',
          }),
        ],
      }),
    )

    await expect(search()).resolves.toEqual([])
  })

  it('той самий підручник знаходиться за власною назвою', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          volume('textbook', {
            title: 'Українська література. 11 клас. Плани-конспекти',
            authors: ['В. В. Паращич'],
          }),
        ],
      }),
    )

    const results = await search('українська література плани-конспекти')

    expect(results).toHaveLength(1)
  })

  // --- Розбір відповіді -----------------------------------------------------

  it('віддає записи типу EDITION з ISBN саме цього тому', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          volume('vol-1', {
            title: 'Тигролови',
            authors: ['Іван Багряний'],
            publishedDate: '2019-05-01',
            publisher: 'Книжковий клуб',
            language: 'uk',
            pageCount: 304,
            industryIdentifiers: [
              { type: 'ISBN_10', identifier: '6177585116' },
              { type: 'ISBN_13', identifier: '978-617-7585-11-3' },
            ],
            imageLinks: { thumbnail: 'http://books.google.com/books?id=vol-1' },
            description: '<p>Опис із <b>розміткою</b></p>',
          }),
        ],
      }),
    )

    const [result] = await search()

    expect(result).toMatchObject({
      id: 'GOOGLE_BOOKS:vol-1',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: 'Тигролови',
      authors: ['Іван Багряний'],
      // Hyphens stripped, http upgraded to https, HTML removed from the description.
      isbn13: '9786177585113',
      publishedYear: 2019,
      publisher: 'Книжковий клуб',
      language: 'uk',
      pageCount: 304,
      coverUrl: 'https://books.google.com/books?id=vol-1',
      description: 'Опис із розміткою',
    })
  })

  it('том без ISBN лишається придатним результатом, просто без поля', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [volume('vol-2', { title: 'Самвидав без ISBN' })] }),
    )

    const [result] = await search('самвидав без isbn')

    expect(result).toMatchObject({ kind: 'EDITION', title: 'Самвидав без ISBN' })
    expect(result).not.toHaveProperty('isbn13')
  })

  it('відкидає ISBN-13, що не проходить контрольну суму', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          volume('vol-3', {
            title: 'Зіпсований ідентифікатор',
            industryIdentifiers: [{ type: 'ISBN_13', identifier: '9786177585119' }],
          }),
        ],
      }),
    )

    const [result] = await search('зіпсований ідентифікатор')

    expect(result).not.toHaveProperty('isbn13')
  })

  it('відкидає невідомий код мови замість того, щоб підставити його як є', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [volume('vol-4', { title: 'Книжка', language: 'zz' })] }),
    )

    const [result] = await search('книжка')

    expect(result).not.toHaveProperty('language')
  })

  it('пропускає томи без назви або без id, не втрачаючи решти видачі', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          { volumeInfo: { title: 'Придатний' } },
          volume('vol-5', {}),
          volume('vol-6', { title: 'Придатний' }),
        ],
      }),
    )

    const results = await search('придатний')

    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Придатний')
  })

  it('відповідь без items — це порожня видача, а не помилка', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await expect(search()).resolves.toEqual([])
  })

  it('HTTP 429 кидає ExternalSearchProviderError, а не «нічого не знайдено»', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429))

    await expect(search()).rejects.toBeInstanceOf(ExternalSearchProviderError)
  })
})
