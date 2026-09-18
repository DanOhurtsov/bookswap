import { bookLookupResultSchema } from '@bookswap/shared'
import {
  normalizeOpenLibraryLanguage,
  OpenLibraryLookupProvider,
} from './open-library-lookup-provider'
import { BookLookupProviderError } from './book-lookup-provider'

/**
 * §6.3, п.7 і cleanup Stage 7: `FakeLookupProvider` (test/lookup/) уже
 * повертає нормалізований `BookLookupResult` — він доводить лише, що
 * `LookupService`/`LookupController` правильно оркеструють провайдера, а не
 * що сама нормалізація Open Library коректна. Тут — прямі тести справжнього
 * `OpenLibraryLookupProvider` із повністю замоканим `fetch` (§11: жодного
 * реального HTTP).
 */
describe('OpenLibraryLookupProvider', () => {
  let fetchMock: jest.Mock
  let provider: OpenLibraryLookupProvider

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock
    provider = new OpenLibraryLookupProvider()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const ISBN = '9783161484100'

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response
  }

  async function lookup(): Promise<ReturnType<OpenLibraryLookupProvider['lookup']>> {
    return provider.lookup(ISBN, new AbortController().signal)
  }

  it('запитує bibkey ISBN:<isbn> у форматі jscmd=data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т' } }))

    await lookup()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string]

    expect(url.startsWith('https://openlibrary.org/api/books.json?')).toBe(true)
    expect(url).toContain('bibkeys=ISBN:9783161484100')
    expect(url).toContain('jscmd=data')
    expect(url).toContain('format=json')
  })

  it('передає AbortSignal у fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т' } }))
    const controller = new AbortController()

    await provider.lookup(ISBN, controller.signal)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  describe('lookupWork', () => {
    it('повертає лише сильний збіг назви й автора', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          docs: [
            { key: '/works/OL111W', title: "Hallowe'en Party", author_name: ['Інша авторка'] },
            {
              key: '/works/OL471832W',
              title: "Hallowe'en Party",
              author_name: ['Agatha Christie'],
            },
          ],
        }),
      )

      await expect(
        provider.lookupWork("Hallowe'en Party", ['Agatha Christie'], new AbortController().signal),
      ).resolves.toBe('OL471832W')

      const [url] = fetchMock.mock.calls[0] as [URL]
      expect(url.origin + url.pathname).toBe('https://openlibrary.org/search.json')
      expect(url.searchParams.get('title')).toBe("Hallowe'en Party")
      expect(url.searchParams.get('author')).toBe('Agatha Christie')
    })

    it('title-only або слабкий авторський збіг не прив’язує Work', async () => {
      await expect(
        provider.lookupWork('Назва', [], new AbortController().signal),
      ).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()

      fetchMock.mockResolvedValue(
        jsonResponse({
          docs: [{ key: '/works/OL111W', title: 'Назва', author_name: ['Тезка Інший'] }],
        }),
      )

      await expect(
        provider.lookupWork('Назва', ['Потрібний Автор'], new AbortController().signal),
      ).resolves.toBeUndefined()
    })
  })

  it('нормалізує title', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Шантарам' } }))

    const result = await lookup()

    expect(result?.title).toBe('Шантарам')
  })

  it('нормалізує authors — масив імен, порожні відкидаються', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Т',
          authors: [{ name: 'Ґреґорі Девід Робертс' }, { name: '  ' }, { name: 'Другий автор' }],
        },
      }),
    )

    const result = await lookup()

    expect(result?.authors).toEqual(['Ґреґорі Девід Робертс', 'Другий автор'])
  })

  it('нормалізує publisher — бере перший запис', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Т',
          publishers: [{ name: 'КСД' }, { name: 'Наступне видавництво' }],
        },
      }),
    )

    const result = await lookup()

    expect(result?.publisher).toBe('КСД')
  })

  it('запитує коректний bibkey для будь-якого ISBN, переданого в lookup()', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'ISBN:9780306406157': { title: 'Т' } }))

    await provider.lookup('9780306406157', new AbortController().signal)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('bibkeys=ISBN:9780306406157')
  })

  it('publish_date → publishedYear (Edition.year, §6.3 п.1)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', publish_date: 'March 2003' } }),
    )

    const result = await lookup()

    expect(result?.publishedYear).toBe(2003)
  })

  it('publish_date без розпізнаваного року — publishedYear відсутній', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', publish_date: 'невідомо коли' } }),
    )

    const result = await lookup()

    expect(result?.publishedYear).toBeUndefined()
  })

  describe('нормалізація мови (§6.3 п.7)', () => {
    it('/languages/eng → en', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: { title: 'Т', languages: [{ key: '/languages/eng' }] },
        }),
      )

      const result = await lookup()

      expect(result?.language).toBe('en')
    })

    it('/languages/ukr → uk', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: { title: 'Т', languages: [{ key: '/languages/ukr' }] },
        }),
      )

      const result = await lookup()

      expect(result?.language).toBe('uk')
    })

    it('декілька мов — детерміновано бере першу', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: {
            title: 'Т',
            languages: [{ key: '/languages/fre' }, { key: '/languages/eng' }],
          },
        }),
      )

      const result = await lookup()

      expect(result?.language).toBe('fr')
    })

    it('невідомий MARC-код — language відсутній, а не вгаданий default', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: { title: 'Т', languages: [{ key: '/languages/mul' }] },
        }),
      )

      const result = await lookup()

      expect(result?.language).toBeUndefined()
    })

    it('languages відсутнє взагалі — language відсутній', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т' } }))

      const result = await lookup()

      expect(result?.language).toBeUndefined()
    })

    it('normalizeOpenLibraryLanguage напряму: bibliographic і terminologic форми ведуть до того самого коду', () => {
      expect(normalizeOpenLibraryLanguage([{ key: '/languages/ger' }])).toBe('de')
      expect(normalizeOpenLibraryLanguage([{ key: '/languages/deu' }])).toBe('de')
    })
  })

  it('нормалізує coverUrl — надає перевагу large, потім medium, потім small', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Т',
          cover: { small: 'https://example.com/s.jpg', medium: 'https://example.com/m.jpg' },
        },
      }),
    )

    const result = await lookup()

    expect(result?.coverUrl).toBe('https://example.com/m.jpg')
  })

  it('нормалізує фізичні поля видання', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Т',
          number_of_pages: 304,
          physical_format: 'Hardcover',
        },
      }),
    )

    const result = await lookup()

    expect(result).toMatchObject({ pageCount: 304, format: 'HARDCOVER' })
  })

  it('externalId — довідковий, похідний з key, і не є обов’язковим', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', key: '/books/OL123456M' } }),
    )

    const withKey = await lookup()
    expect(withKey?.externalId).toBe('OL123456M')

    fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Без ключа' } }))
    const withoutKey = await lookup()
    expect(withoutKey?.externalId).toBeUndefined()
  })

  it('відсутні опційні поля — лишається тільки title', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Тільки назва' } }))

    const result = await lookup()

    expect(result).toEqual({ title: 'Тільки назва' })
  })

  describe('зіпсовані типи полів — не валять весь lookup', () => {
    it('authors не масив — ігнорується, решта поля лишаються', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: { title: 'Т', authors: 'не масив', publisher: 'ігнор' },
        }),
      )

      const result = await lookup()

      expect(result?.authors).toBeUndefined()
      expect(result?.title).toBe('Т')
    })

    it('publishers — елемент без властивостей або не той тип — publisher відсутній', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', publishers: [42, null] } }),
      )

      const result = await lookup()

      expect(result?.publisher).toBeUndefined()
    })

    it('cover — не обʼєкт — coverUrl відсутній', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', cover: 'не обʼєкт' } }),
      )

      const result = await lookup()

      expect(result?.coverUrl).toBeUndefined()
    })

    it('publish_date — число замість рядка — publishedYear відсутній', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', publish_date: 2003 } }),
      )

      const result = await lookup()

      expect(result?.publishedYear).toBeUndefined()
    })

    it('key — число замість рядка — externalId відсутній', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', key: 12345 } }))

      const result = await lookup()

      expect(result?.externalId).toBeUndefined()
    })

    it('languages — елемент із key не-рядком — language відсутній', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Т', languages: [{ key: 7 }] } }),
      )

      const result = await lookup()

      expect(result?.language).toBeUndefined()
    })

    it('title не рядок — трактується як «без назви», BookLookupProviderError', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 12345 } }))

      await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
    })
  })

  it('порожній bibkey перевіряє точний ISBN через Search API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(
      jsonResponse({
        docs: [
          {
            key: '/works/OL24348752W',
            title: 'Influence, New and Expanded',
            author_name: ['Robert B Cialdini PhD'],
            isbn: ['0063136899', ISBN],
          },
        ],
      }),
    )

    const result = await lookup()

    expect(result).toEqual({
      title: 'Influence, New and Expanded',
      authors: ['Robert B Cialdini PhD'],
      workExternalId: 'OL24348752W',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url] = fetchMock.mock.calls[1] as [URL]
    expect(url.origin + url.pathname).toBe('https://openlibrary.org/search.json')
    expect(url.searchParams.get('isbn')).toBe(ISBN)
  })

  it('пошук не приймає схожий запис без точного ISBN', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(
      jsonResponse({
        docs: [{ key: '/works/OL1W', title: 'Схожа книга', isbn: ['9780306406157'] }],
      }),
    )

    await expect(lookup()).resolves.toBeUndefined()
  })

  it('запис без title — BookLookupProviderError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ [`ISBN:${ISBN}`]: { authors: [{ name: 'Хтось' }] } }),
    )

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })

  it('non-2xx відповідь — BookLookupProviderError, не тихе падіння', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503))

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })

  it('невалідний JSON у тілі — BookLookupProviderError', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    })

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })

  it('JSON null замість об’єкта — BookLookupProviderError, а не TypeError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null))

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })

  it('мережева помилка/timeout (AbortError від fetch) доходить як BookLookupProviderError', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })

  it('нормалізована відповідь проходить bookLookupResultSchema без утрат', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        [`ISBN:${ISBN}`]: {
          title: 'Шантарам',
          authors: [{ name: 'Ґреґорі Девід Робертс' }],
          publish_date: '2003',
          publishers: [{ name: 'КСД' }],
          cover: { large: 'https://example.com/l.jpg' },
          languages: [{ key: '/languages/eng' }],
          key: '/books/OL123456M',
        },
      }),
    )

    const result = await lookup()

    expect(result).toBeDefined()
    expect(bookLookupResultSchema.parse(result)).toEqual(result)
  })

  /**
   * Stage 8f-2, R7: the real adapter with a faked HTTP transport — the batch
   * path has to tell three things apart, and the third one is where a bad
   * answer used to become a confident "no such book".
   */
  describe('lookupMany (batch)', () => {
    const OTHER = '9780306406157'
    const THIRD = '9780262033848'

    async function lookupMany(isbns: readonly string[]) {
      return provider.lookupMany(isbns, new AbortController().signal)
    }

    it('шле всі bibkeys одним запитом', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      await lookupMany([ISBN, OTHER])

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url] = fetchMock.mock.calls[0] as [string]

      expect(url).toContain(`bibkeys=ISBN:${ISBN},ISBN:${OTHER}`)
    })

    it('відсутній bibkey — не знайдено, а не помилка', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ [`ISBN:${ISBN}`]: { title: 'Є' } }))

      const result = await lookupMany([ISBN, OTHER])

      expect([...result.found.keys()]).toEqual([ISBN])
      expect(result.failed.size).toBe(0)
    })

    /**
     * The record IS there, we just cannot read it. Reporting that as "absent"
     * would let the caller conclude the book does not exist — a claim about the
     * book made from a fact about the answer.
     */
    it('пошкоджений запис — помилка саме цього ISBN, решта batch уціліла', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          [`ISBN:${ISBN}`]: { title: 'Ціла книга' },
          [`ISBN:${OTHER}`]: { title: '   ' },
          [`ISBN:${THIRD}`]: { authors: [{ name: 'Без назви' }] },
        }),
      )

      const result = await lookupMany([ISBN, OTHER, THIRD])

      expect([...result.found.keys()]).toEqual([ISBN])
      expect([...result.failed.keys()].sort()).toEqual([THIRD, OTHER].sort())
      expect(result.failed.get(OTHER)).toContain('без назви')
    })

    it('batch НЕ робить пошуку по ISBN і не збагачує Work — це був би N+1', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      await lookupMany([ISBN, OTHER, THIRD])

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('HTTP-помилка валить увесь batch, а не окремий ISBN', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 503))

      await expect(lookupMany([ISBN])).rejects.toBeInstanceOf(BookLookupProviderError)
    })

    it('більше за ліміт bibkeys — помилка до мережі', async () => {
      const many = Array.from({ length: 51 }, (_, index) => `isbn-${String(index)}`)

      await expect(lookupMany(many)).rejects.toBeInstanceOf(BookLookupProviderError)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
