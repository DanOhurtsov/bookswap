import type { BookLookupResult } from '@bookswap/shared'
import { BatchedBookLookupProvider } from './batched-book-lookup-provider'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import type { OpenLibraryLookupProvider } from './open-library-lookup-provider'

/**
 * Stage 8f-2, R7 + R7a. Two properties are being pinned here, and both are
 * about restraint rather than results: Open Library is asked in batches, and
 * the single-ISBN providers are asked a bounded number of times.
 */

const RESULT: BookLookupResult = { title: 'Дюна' }

function isbn(index: number): string {
  return `978030640615${index % 10}-${index}`
}

interface FakeOpenLibrary {
  batches: string[][]
  lookupMany: OpenLibraryLookupProvider['lookupMany']
}

/** Answers `known`, reports every batch it was asked for, or fails wholesale. */
function fakeOpenLibrary(options: {
  known?: readonly string[]
  /** Bibkeys the answer mentions but whose record cannot be read. */
  corrupt?: readonly string[]
  fail?: 'error' | 'hang'
}): FakeOpenLibrary {
  const known = new Set(options.known ?? [])
  const batches: string[][] = []

  return {
    batches,
    lookupMany: (isbns, signal) => {
      batches.push([...isbns])

      if (options.fail === 'error') {
        return Promise.reject(new BookLookupProviderError('Open Library down'))
      }

      if (options.fail === 'hang') {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
      }

      return Promise.resolve({
        found: new Map(isbns.filter((value) => known.has(value)).map((value) => [value, RESULT])),
        failed: new Map(
          isbns
            .filter((value) => (options.corrupt ?? []).includes(value))
            .map((value) => [value, 'Open Library повернув запис без назви']),
        ),
      })
    },
  }
}

interface FakeSingle {
  calls: string[]
  provider: BookLookupProvider
}

function fakeSingle(options: { known?: readonly string[]; fail?: boolean } = {}): FakeSingle {
  const known = new Set(options.known ?? [])
  const calls: string[] = []

  return {
    calls,
    provider: {
      lookup: (value) => {
        calls.push(value)

        if (options.fail === true) {
          return Promise.reject(new BookLookupProviderError('провайдер зламався'))
        }

        return Promise.resolve(known.has(value) ? RESULT : undefined)
      },
    },
  }
}

function build(
  openLibrary: FakeOpenLibrary,
  google: FakeSingle,
  isbnDb: FakeSingle,
): BatchedBookLookupProvider {
  return new BatchedBookLookupProvider(
    openLibrary as unknown as OpenLibraryLookupProvider,
    // No cast: the concrete single-ISBN classes add nothing beyond `lookup`.
    google.provider,
    isbnDb.provider,
  )
}

const signal = (): AbortSignal => new AbortController().signal

describe('BatchedBookLookupProvider', () => {
  it('asks Open Library in chunks of 50, not once per ISBN', async () => {
    const isbns = Array.from({ length: 120 }, (_, index) => isbn(index))
    const openLibrary = fakeOpenLibrary({ known: isbns })
    const google = fakeSingle()
    const isbnDb = fakeSingle()

    const outcome = await build(openLibrary, google, isbnDb).lookupMany(isbns, signal())

    expect(openLibrary.batches.map((batch) => batch.length)).toEqual([50, 50, 20])
    expect(outcome.found.size).toBe(120)
    expect(google.calls).toHaveLength(0)
    expect(isbnDb.calls).toHaveLength(0)
  })

  it('falls back to the single-ISBN providers only for what Open Library missed', async () => {
    const openLibrary = fakeOpenLibrary({ known: ['known'] })
    const google = fakeSingle({ known: ['google-knows'] })
    const isbnDb = fakeSingle({ known: ['isbndb-knows'] })

    const outcome = await build(openLibrary, google, isbnDb).lookupMany(
      ['known', 'google-knows', 'isbndb-knows', 'nobody-knows'],
      signal(),
    )

    expect(google.calls.sort()).toEqual(['google-knows', 'isbndb-knows', 'nobody-knows'])
    // ISBNdb is spared the one Google already answered.
    expect(isbnDb.calls.sort()).toEqual(['isbndb-knows', 'nobody-knows'])
    expect([...outcome.found.keys()].sort()).toEqual(['google-knows', 'isbndb-knows', 'known'])
    expect(outcome.notFound).toEqual(new Set(['nobody-knows']))
    expect(outcome.unavailable.size).toBe(0)
  })

  /**
   * The distinction the whole contract rests on: a provider that finished its
   * search and found nothing is a fact about the book; a provider that broke or
   * timed out is a fact about today.
   */
  it('keeps an outage and a timeout apart from "no such book"', async () => {
    const outcome = await build(
      fakeOpenLibrary({ fail: 'error' }),
      fakeSingle({ fail: true }),
      fakeSingle({ fail: true }),
    ).lookupMany(['a'], signal())

    expect(outcome.notFound.size).toBe(0)
    expect(outcome.unavailable.get('a')).toBe('PROVIDER_ERROR')
  })

  it('reports a hung Open Library batch as a timeout, not an error', async () => {
    process.env.CATALOG_LOOKUP_TIMEOUT_MS = '20'

    try {
      const outcome = await build(
        fakeOpenLibrary({ fail: 'hang' }),
        fakeSingle(),
        fakeSingle(),
      ).lookupMany(['a'], signal())

      // Google and ISBNdb still ran and found nothing, but the earlier timeout
      // is what the row is told about: the search never completed everywhere.
      expect(outcome.unavailable.get('a')).toBe('TIMEOUT')
    } finally {
      delete process.env.CATALOG_LOOKUP_TIMEOUT_MS
    }
  })

  it('a later provider answering cancels an earlier one failing', async () => {
    const outcome = await build(
      fakeOpenLibrary({ fail: 'error' }),
      fakeSingle({ fail: true }),
      fakeSingle({ known: ['a'] }),
    ).lookupMany(['a'], signal())

    expect(outcome.found.get('a')).toEqual(RESULT)
    expect(outcome.unavailable.size).toBe(0)
  })

  it('spends the fallback budget in file order and marks the rest retryable', async () => {
    process.env.CATALOG_LOOKUP_FALLBACK_BUDGET = '2'

    try {
      const google = fakeSingle({ known: ['a', 'b', 'c'] })
      const outcome = await build(fakeOpenLibrary({}), google, fakeSingle()).lookupMany(
        ['a', 'b', 'c'],
        signal(),
      )

      expect(google.calls.sort()).toEqual(['a', 'b'])
      expect([...outcome.found.keys()].sort()).toEqual(['a', 'b'])
      expect(outcome.unavailable.get('c')).toBe('BUDGET_EXHAUSTED')
      expect(outcome.notFound.size).toBe(0)
    } finally {
      delete process.env.CATALOG_LOOKUP_FALLBACK_BUDGET
    }
  })

  it('never spends the budget twice on a repeated ISBN', async () => {
    const google = fakeSingle()
    const openLibrary = fakeOpenLibrary({})

    await build(openLibrary, google, fakeSingle()).lookupMany(['a', 'a', 'a'], signal())

    expect(openLibrary.batches).toEqual([['a']])
    expect(google.calls).toEqual(['a'])
  })

  /**
   * The failure that used to disappear: Open Library answered, the record for
   * one ISBN was unreadable, and the ISBN fell through to the fallback as if
   * nothing had happened — so "Google does not know it either" became
   * `notFound`, and `LookupService` then cached that as a negative for a day.
   */
  it('пошкоджений запис OL не стає «не знайдено», навіть коли fallback теж мовчить', async () => {
    const outcome = await build(
      fakeOpenLibrary({ known: ['good'], corrupt: ['broken'] }),
      fakeSingle(),
      fakeSingle(),
    ).lookupMany(['good', 'broken'], signal())

    expect([...outcome.found.keys()]).toEqual(['good'])
    expect(outcome.notFound.size).toBe(0)
    expect(outcome.unavailable.get('broken')).toBe('PROVIDER_ERROR')
  })

  it('успішний fallback компенсує пошкоджений запис OL', async () => {
    const outcome = await build(
      fakeOpenLibrary({ corrupt: ['broken'] }),
      fakeSingle({ known: ['broken'] }),
      fakeSingle(),
    ).lookupMany(['broken'], signal())

    expect(outcome.found.get('broken')).toEqual(RESULT)
    expect(outcome.unavailable.size).toBe(0)
  })

  /** A bibkey simply absent from the answer keeps meaning "no record". */
  it('відсутній bibkey і далі дає NOT_FOUND після мовчазного fallback', async () => {
    const outcome = await build(fakeOpenLibrary({}), fakeSingle(), fakeSingle()).lookupMany(
      ['absent'],
      signal(),
    )

    expect(outcome.notFound).toEqual(new Set(['absent']))
    expect(outcome.unavailable.size).toBe(0)
  })
})
