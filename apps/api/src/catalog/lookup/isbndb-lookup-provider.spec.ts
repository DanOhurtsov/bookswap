import { BookLookupProviderError } from './book-lookup-provider'
import { IsbnDbLookupProvider } from './isbndb-lookup-provider'

describe('IsbnDbLookupProvider', () => {
  const ISBN = '9786171502789'
  let fetchMock: jest.Mock
  let provider: IsbnDbLookupProvider
  let previousApiKey: string | undefined
  let previousApiUrl: string | undefined

  beforeEach(() => {
    previousApiKey = process.env.ISBNDB_API_KEY
    previousApiUrl = process.env.ISBNDB_API_URL
    delete process.env.ISBNDB_API_KEY
    delete process.env.ISBNDB_API_URL
    fetchMock = jest.fn()
    global.fetch = fetchMock
    provider = new IsbnDbLookupProvider()
  })

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.ISBNDB_API_KEY
    else process.env.ISBNDB_API_KEY = previousApiKey
    if (previousApiUrl === undefined) delete process.env.ISBNDB_API_URL
    else process.env.ISBNDB_API_URL = previousApiUrl
    jest.restoreAllMocks()
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response
  }

  async function lookup() {
    return provider.lookup(ISBN, new AbortController().signal)
  }

  it('без API key вимкнений і не робить HTTP-запиту', async () => {
    await expect(lookup()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('перевіряє точний ISBN і нормалізує ISBNdb book', async () => {
    process.env.ISBNDB_API_KEY = 'isbn-secret'
    process.env.ISBNDB_API_URL = 'https://isbn.example.test/'
    fetchMock.mockResolvedValue(
      jsonResponse({
        book: {
          isbn13: '978-617-15-0278-9',
          title: 'Вечірка на Гелловін',
          authors: ['Аґата Крісті'],
          publisher: 'КСД',
          date_published: '2023',
          language: 'uk',
          pages: 304,
          binding: 'Hardcover',
          synopsis: 'Опис книжки',
          image_original: 'https://images.example.test/cover.jpg',
        },
      }),
    )

    await expect(lookup()).resolves.toEqual({
      title: 'Вечірка на Гелловін',
      authors: ['Аґата Крісті'],
      publisher: 'КСД',
      publishedYear: 2023,
      language: 'uk',
      description: 'Опис книжки',
      pageCount: 304,
      format: 'HARDCOVER',
      coverUrl: 'https://images.example.test/cover.jpg',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://isbn.example.test/book/${ISBN}`)
    expect(init.headers).toEqual(
      expect.objectContaining({ 'x-api-key': 'isbn-secret', Accept: 'application/json' }),
    )
  })

  it('не приймає запис з іншим ISBN', async () => {
    process.env.ISBNDB_API_KEY = 'isbn-secret'
    fetchMock.mockResolvedValue(
      jsonResponse({ book: { isbn13: '9783161484100', title: 'Інша книжка' } }),
    )

    await expect(lookup()).resolves.toBeUndefined()
  })

  it('404 означає not found, інші HTTP-помилки — provider error', async () => {
    process.env.ISBNDB_API_KEY = 'isbn-secret'
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 500))

    await expect(lookup()).resolves.toBeUndefined()
    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })
})
