import { searchExternalCatalogs } from './search-external'

jest.mock('@/app/lib/api', () => ({ apiRequest: jest.fn() }))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('searchExternalCatalogs', () => {
  it('звертається до власного бекенду, а не до провайдера напряму', async () => {
    mockApiRequest.mockResolvedValue({ results: [], sources: [], page: 1, hasMore: false })

    await searchExternalCatalogs('тигролови', 1, 10)

    const [path] = mockApiRequest.mock.calls[0] as [string]
    expect(path).toBe(
      '/catalog/search/external?q=%D1%82%D0%B8%D0%B3%D1%80%D0%BE%D0%BB%D0%BE%D0%B2%D0%B8&page=1&pageSize=10',
    )
  })

  it('сторінка й розмір їдуть в запит явно — обидві половини списку питають те саме', async () => {
    mockApiRequest.mockResolvedValue({ results: [], sources: [], page: 3, hasMore: false })

    await searchExternalCatalogs('тигролови', 3, 50)

    const [path] = mockApiRequest.mock.calls[0] as [string]
    expect(path).toContain('&page=3&pageSize=50')
  })
})
