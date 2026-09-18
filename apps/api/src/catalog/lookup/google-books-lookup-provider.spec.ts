import { BookLookupProviderError } from './book-lookup-provider'
import { GoogleBooksLookupProvider } from './google-books-lookup-provider'

describe('GoogleBooksLookupProvider', () => {
  const ISBN = '9786171502789'
  let fetchMock: jest.Mock
  let provider: GoogleBooksLookupProvider
  let previousApiKey: string | undefined

  beforeEach(() => {
    previousApiKey = process.env.GOOGLE_BOOKS_API_KEY
    delete process.env.GOOGLE_BOOKS_API_KEY
    fetchMock = jest.fn()
    global.fetch = fetchMock
    provider = new GoogleBooksLookupProvider()
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

  async function lookup() {
    return provider.lookup(ISBN, new AbortController().signal)
  }

  it('шукає через isbn: і передає опційний серверний API key', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'server-secret'
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }))

    await lookup()

    const [request, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(request.searchParams.get('q')).toBe(`isbn:${ISBN}`)
    expect(request.searchParams.get('key')).toBe('server-secret')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('приймає лише item із точним ISBN і нормалізує метадані', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'wrong',
            volumeInfo: {
              title: 'Інша книжка',
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9783161484100' }],
            },
          },
          {
            id: 'google-volume',
            volumeInfo: {
              title: 'Вечірка на Гелловін',
              authors: ['Аґата Крісті'],
              publisher: 'КСД',
              publishedDate: '2023-09-01',
              language: 'uk',
              description: '<b>Класичний</b><br>детектив &amp; загадка',
              pageCount: 304,
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '978-617-15-0278-9' }],
              imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
            },
          },
        ],
      }),
    )

    await expect(lookup()).resolves.toEqual({
      title: 'Вечірка на Гелловін',
      authors: ['Аґата Крісті'],
      publisher: 'КСД',
      publishedYear: 2023,
      language: 'uk',
      description: 'Класичний\nдетектив & загадка',
      pageCount: 304,
      coverUrl: 'https://books.google.com/cover.jpg',
      externalId: 'google-volume',
    })
  })

  it('результат пошуку без точного ISBN трактує як not found', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            volumeInfo: {
              title: 'Схожа книжка',
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9783161484100' }],
            },
          },
        ],
      }),
    )

    await expect(lookup()).resolves.toBeUndefined()
  })

  it('HTTP-помилку загортає в BookLookupProviderError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429))

    await expect(lookup()).rejects.toBeInstanceOf(BookLookupProviderError)
  })
})
