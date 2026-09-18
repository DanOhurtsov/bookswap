import { searchAddBookCandidates } from './search-add-book'

jest.mock('@/app/lib/api', () => ({ apiRequest: jest.fn() }))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('after an ISBN miss searches local Works once more by the exact external title', async () => {
  const candidate = { work: { id: 'existing-work', title: 'Вечірка на Гелловін' } }

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/catalog/search/candidates?q=9786171502789') {
      return Promise.resolve({ candidates: [] })
    }
    if (path === '/catalog/lookup?isbn=9786171502789') {
      return Promise.resolve({
        result: { title: 'Вечірка на Гелловін', authors: ['Аґата Крісті'] },
      })
    }
    if (
      path.startsWith('/catalog/search/candidates?q=') &&
      decodeURIComponent(path.split('=')[1] ?? '') === 'Вечірка на Гелловін'
    ) {
      return Promise.resolve({ candidates: [candidate] })
    }

    return Promise.reject(new Error(`Unexpected path: ${path}`))
  })

  const result = await searchAddBookCandidates('9786171502789')

  expect(result.candidates).toEqual([candidate])
  expect(result.lookup?.title).toBe('Вечірка на Гелловін')
  expect(mockApiRequest).toHaveBeenCalledTimes(3)
})

it('keeps exact external metadata when best-effort title dedup search fails', async () => {
  mockApiRequest
    .mockResolvedValueOnce({ candidates: [] })
    .mockResolvedValueOnce({ result: { title: 'Вечірка на Гелловін' } })
    .mockRejectedValueOnce(new Error('candidate search unavailable'))

  await expect(searchAddBookCandidates('9786171502789')).resolves.toMatchObject({
    candidates: [],
    lookup: { title: 'Вечірка на Гелловін' },
  })
})
