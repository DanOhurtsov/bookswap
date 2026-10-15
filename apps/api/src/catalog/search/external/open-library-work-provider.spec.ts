import { BookLookupProviderError } from '../../lookup/book-lookup-provider'
import { OpenLibraryWorkProvider } from './open-library-work-provider'

describe('OpenLibraryWorkProvider', () => {
  let fetchMock: jest.Mock
  const provider = new OpenLibraryWorkProvider()
  const signal = new AbortController().signal

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock
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

  const document = {
    key: '/works/OL45804W',
    title: 'Fantastic Mr Fox',
    author_name: ['Roald Dahl'],
    first_publish_year: 1970,
    language: ['eng', 'ukr'],
    cover_i: 6498519,
  }

  it('питає рівно один твір за key — ті самі поля, що й пошук за назвою', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [document] }))

    await provider.fetchWork('OL45804W', signal)

    const [url] = fetchMock.mock.calls[0] as [URL]

    expect(url.searchParams.get('q')).toBe('key:"/works/OL45804W"')
    expect(url.searchParams.get('fields')).toBe(
      'key,title,author_name,first_publish_year,language,cover_i',
    )
    expect(url.searchParams.get('limit')).toBe('1')
  })

  it('повертає той самий запис WORK, що й картка пошуку: назва, автори, рік першої публікації, обкладинка', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [document] }))

    expect(await provider.fetchWork('OL45804W', signal)).toEqual({
      id: 'OPEN_LIBRARY:OL45804W',
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: 'Fantastic Mr Fox',
      externalId: 'OL45804W',
      workExternalId: 'OL45804W',
      authors: ['Roald Dahl'],
      firstPublishedYear: 1970,
      coverUrl: 'https://covers.openlibrary.org/b/id/6498519-M.jpg',
    })
  })

  it('документ іншого твору — не відповідь про цей: undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [{ ...document, key: '/works/OL1W' }] }))

    expect(await provider.fetchWork('OL45804W', signal)).toBeUndefined()
  })

  it('порожня відповідь — такого твору немає', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }))

    expect(await provider.fetchWork('OL45804W', signal)).toBeUndefined()
  })

  it('HTTP-помилка чи не-JSON — помилка провайдера, а не «не знайдено»', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503))
    await expect(provider.fetchWork('OL45804W', signal)).rejects.toBeInstanceOf(
      BookLookupProviderError,
    )

    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    await expect(provider.fetchWork('OL45804W', signal)).rejects.toBeInstanceOf(
      BookLookupProviderError,
    )
  })
})
