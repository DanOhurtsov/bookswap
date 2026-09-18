import type { BookLookupResult } from '@bookswap/shared'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import { FallbackBookLookupProvider } from './fallback-book-lookup-provider'

describe('FallbackBookLookupProvider', () => {
  const ISBN = '9786171502789'

  function fake(result: BookLookupResult | undefined | Error): jest.Mocked<BookLookupProvider> {
    return {
      lookup: jest.fn((_isbn: string, _signal: AbortSignal) =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      ),
    }
  }

  function provider(
    openLibrary: BookLookupProvider,
    googleBooks: BookLookupProvider,
    isbnDb: BookLookupProvider,
    workExternalId?: string,
  ): FallbackBookLookupProvider {
    const openLibraryWithWorkLookup = {
      ...openLibrary,
      lookupWork: jest.fn().mockResolvedValue(workExternalId),
      // The single-ISBN cascade never batches; the stub only satisfies the class type.
      lookupMany: jest.fn().mockResolvedValue(new Map()),
    }

    return new FallbackBookLookupProvider(openLibraryWithWorkLookup, googleBooks, isbnDb)
  }

  it('повертає перший знайдений точний запис із джерелом і зупиняє каскад', async () => {
    const openLibrary = fake({ title: 'Open result' })
    const googleBooks = fake({ title: 'Google result' })
    const isbnDb = fake({ title: 'ISBNdb result' })

    await expect(
      provider(openLibrary, googleBooks, isbnDb).lookup(ISBN, new AbortController().signal),
    ).resolves.toEqual({ title: 'Open result', source: 'OPEN_LIBRARY' })
    expect(googleBooks.lookup.mock.calls).toHaveLength(0)
    expect(isbnDb.lookup.mock.calls).toHaveLength(0)
  })

  it('після not found переходить до наступного провайдера', async () => {
    await expect(
      provider(fake(undefined), fake({ title: 'Google result' }), fake(undefined)).lookup(
        ISBN,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ title: 'Google result', source: 'GOOGLE_BOOKS' })
  })

  it('додає лише сильний Open Library Work match як довідковий external id', async () => {
    await expect(
      provider(
        fake(undefined),
        fake({ title: "Hallowe'en Party", authors: ['Agatha Christie'] }),
        fake(undefined),
        'OL471832W',
      ).lookup(ISBN, new AbortController().signal),
    ).resolves.toEqual({
      title: "Hallowe'en Party",
      authors: ['Agatha Christie'],
      source: 'GOOGLE_BOOKS',
      workExternalId: 'OL471832W',
    })
  })

  it('зберігає Work ID з exact-ISBN відповіді без повторного work search', async () => {
    const openLibrary = fake({
      title: 'Influence, New and Expanded',
      authors: ['Robert B Cialdini PhD'],
      workExternalId: 'OL24348752W',
    })
    const openLibraryWithWorkLookup = {
      ...openLibrary,
      lookupWork: jest.fn(),
      lookupMany: jest.fn().mockResolvedValue(new Map()),
    }
    const fallback = new FallbackBookLookupProvider(
      openLibraryWithWorkLookup,
      fake(undefined),
      fake(undefined),
    )

    await expect(fallback.lookup(ISBN, new AbortController().signal)).resolves.toEqual({
      title: 'Influence, New and Expanded',
      authors: ['Robert B Cialdini PhD'],
      source: 'OPEN_LIBRARY',
      workExternalId: 'OL24348752W',
    })
    expect(openLibraryWithWorkLookup.lookupWork).not.toHaveBeenCalled()
  })

  it('помилка одного провайдера не заважає успіху наступного', async () => {
    await expect(
      provider(
        fake(new BookLookupProviderError('Open Library down')),
        fake({ title: 'Google result' }),
        fake(undefined),
      ).lookup(ISBN, new AbortController().signal),
    ).resolves.toEqual({ title: 'Google result', source: 'GOOGLE_BOOKS' })
  })

  it('усі clean misses повертають undefined', async () => {
    await expect(
      provider(fake(undefined), fake(undefined), fake(undefined)).lookup(
        ISBN,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it('без результату не приховує помилки провайдерів', async () => {
    await expect(
      provider(
        fake(new BookLookupProviderError('Open Library down')),
        fake(undefined),
        fake(undefined),
      ).lookup(ISBN, new AbortController().signal),
    ).rejects.toThrow('Open Library')
  })
})
