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

  function hanging(): jest.Mocked<BookLookupProvider> {
    return {
      lookup: jest.fn(
        (_isbn: string, _signal: AbortSignal) =>
          new Promise<BookLookupResult | undefined>(() => undefined),
      ),
    }
  }

  function provider(
    openLibrary: BookLookupProvider,
    googleBooks: BookLookupProvider,
    workExternalId?: string,
  ): FallbackBookLookupProvider {
    const openLibraryWithWorkLookup = {
      ...openLibrary,
      lookupWork: jest.fn().mockResolvedValue(workExternalId),
      // The single-ISBN lookup never batches; the stub only satisfies the class type.
      lookupMany: jest.fn().mockResolvedValue(new Map()),
    }

    return new FallbackBookLookupProvider(openLibraryWithWorkLookup, googleBooks)
  }

  function lookup(fallback: FallbackBookLookupProvider): Promise<BookLookupResult | undefined> {
    return fallback.lookup(ISBN, new AbortController().signal)
  }

  it('питає обидва джерела одразу, не чекаючи відповіді першого', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '20'

    const openLibrary = hanging()
    const googleBooks = fake({ title: 'Google result' })

    try {
      await lookup(provider(openLibrary, googleBooks))
    } finally {
      delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    }

    expect(openLibrary.lookup.mock.calls).toHaveLength(1)
    expect(googleBooks.lookup.mock.calls).toHaveLength(1)
  })

  it('об’єднує записи: основа — Open Library, прогалини заповнює Google Books', async () => {
    const result = await lookup(
      provider(
        fake({ title: 'Open title', authors: ['Open Author'], externalId: 'OL1M' }),
        fake({
          title: 'Google title',
          authors: ['Google Author'],
          publisher: 'Google Publisher',
          coverUrl: 'https://example.com/cover.jpg',
          externalId: 'google-id',
        }),
      ),
    )

    expect(result).toEqual({
      title: 'Open title',
      authors: ['Open Author'],
      publisher: 'Google Publisher',
      coverUrl: 'https://example.com/cover.jpg',
      source: 'OPEN_LIBRARY',
      externalId: 'OL1M',
    })
  })

  it('не позичає externalId іншого джерела', async () => {
    const result = await lookup(
      provider(fake({ title: 'Open title' }), fake({ title: 'Google', externalId: 'google-id' })),
    )

    expect(result).toEqual({ title: 'Open title', source: 'OPEN_LIBRARY' })
  })

  it('якщо знає лише Google Books, повертає його запис із джерелом', async () => {
    await expect(
      lookup(provider(fake(undefined), fake({ title: 'Google result' }))),
    ).resolves.toEqual({ title: 'Google result', source: 'GOOGLE_BOOKS' })
  })

  it('додає лише сильний Open Library Work match як довідковий external id', async () => {
    await expect(
      lookup(
        provider(
          fake(undefined),
          fake({ title: "Hallowe'en Party", authors: ['Agatha Christie'] }),
          'OL471832W',
        ),
      ),
    ).resolves.toEqual({
      title: "Hallowe'en Party",
      authors: ['Agatha Christie'],
      source: 'GOOGLE_BOOKS',
      workExternalId: 'OL471832W',
    })
  })

  it('зберігає Work ID з exact-ISBN відповіді без повторного work search', async () => {
    const lookupWork = jest.fn()
    const openLibrary = {
      ...fake({
        title: 'Influence, New and Expanded',
        authors: ['Robert B Cialdini PhD'],
        workExternalId: 'OL24348752W',
      }),
      lookupWork,
      lookupMany: jest.fn().mockResolvedValue(new Map()),
    }

    await expect(
      lookup(new FallbackBookLookupProvider(openLibrary, fake(undefined))),
    ).resolves.toEqual({
      title: 'Influence, New and Expanded',
      authors: ['Robert B Cialdini PhD'],
      source: 'OPEN_LIBRARY',
      workExternalId: 'OL24348752W',
    })
    expect(lookupWork.mock.calls).toHaveLength(0)
  })

  it('помилка одного джерела не заважає відповіді іншого', async () => {
    await expect(
      lookup(
        provider(fake(new BookLookupProviderError('Open Library down')), fake({ title: 'Google' })),
      ),
    ).resolves.toEqual({ title: 'Google', source: 'GOOGLE_BOOKS' })
  })

  it('повільне джерело не віднімає відповідь, яку вже маємо', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '20'

    try {
      await expect(lookup(provider(fake({ title: 'Open result' }), hanging()))).resolves.toEqual({
        title: 'Open result',
        source: 'OPEN_LIBRARY',
      })
    } finally {
      delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    }
  })

  it('усі clean misses повертають undefined', async () => {
    await expect(lookup(provider(fake(undefined), fake(undefined)))).resolves.toBeUndefined()
  })

  it('без результату не приховує помилки джерел', async () => {
    await expect(
      lookup(provider(fake(new BookLookupProviderError('Open Library down')), fake(undefined))),
    ).rejects.toThrow('Open Library')
  })

  it('таймаут джерела без жодного результату — помилка, а не «не знайдено»', async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS = '20'

    try {
      await expect(lookup(provider(fake(undefined), hanging()))).rejects.toThrow('Google Books')
    } finally {
      delete process.env.CATALOG_EXTERNAL_SEARCH_TIMEOUT_MS
    }
  })
})
