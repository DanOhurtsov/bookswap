import type { AddSearchEditionItem, AddSearchResponse } from '@bookswap/shared'
import {
  externalPageFinal,
  nextPageWithAhead,
  type AheadPage,
  type ExternalPage,
} from './add-search-pages'

const row: AddSearchEditionItem = {
  kind: 'EDITION',
  key: 'edition:e-1',
  edition: {
    id: 'e-1',
    workId: 'w-1',
    translationId: null,
    textKind: 'UNKNOWN',
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: null,
    lang: null,
    translator: null,
    revision: 1,
  },
  work: {
    id: 'w-1',
    title: 'Книжка',
    origLang: null,
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  matchedOn: 'TITLE',
  ownership: { activeCount: 0, archivedCount: 0 },
}

const local = (overrides: Partial<AddSearchResponse> = {}): AddSearchResponse => ({
  items: [],
  page: 2,
  pageSize: 10,
  total: 0,
  hasMore: false,
  ...overrides,
})

const external = (overrides: Partial<ExternalPage> = {}): ExternalPage => ({
  results: [],
  sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
  page: 2,
  pageSize: 10,
  more: 'NO',
  complete: true,
  ...overrides,
})

const success = <T>(data: T) => ({ status: 'success' as const, data })

/** Page 2 loaded ahead, final and empty, both halves asked. */
const endedAhead: AheadPage = {
  local: success(local()),
  external: success(external()),
  externalAsked: true,
}

describe('externalPageFinal', () => {
  it('keeps a complete page every asked source answered', () => {
    expect(externalPageFinal(external())).toBe(true)
  })

  it('a page with no source asked (sources: []) is no failure', () => {
    expect(externalPageFinal(external({ sources: [] }))).toBe(true)
  })

  it.each(['ERROR', 'TIMEOUT', 'RATE_LIMITED'] as const)(
    'a page a source answered %s for is not final, even complete',
    (status) => {
      expect(
        externalPageFinal(
          external({
            sources: [
              { source: 'GOOGLE_BOOKS', status: 'OK' },
              { source: 'OPEN_LIBRARY', status },
            ],
          }),
        ),
      ).toBe(false)
    },
  )

  it('a partial page is not final', () => {
    expect(externalPageFinal(external({ complete: false }))).toBe(false)
  })
})

describe('nextPageWithAhead', () => {
  it('a final, empty next page with the end confirmed proves the end — even after a PROVEN promise', () => {
    expect(nextPageWithAhead('POSSIBLE', endedAhead)).toBe('NONE')
    // The «три» case: page 4 promised page 5 (`more = YES`), page 5 came back final and empty.
    expect(nextPageWithAhead('PROVEN', endedAhead)).toBe('NONE')
  })

  it('the page’s own end (NONE) is never overruled, even by rows loaded ahead', () => {
    expect(
      nextPageWithAhead('NONE', { ...endedAhead, local: success(local({ items: [row] })) }),
    ).toBe('NONE')
  })

  it.each(['POSSIBLE', 'PROVEN'] as const)(
    'rows already loaded for the next page prove it after %s — either half, even a partial one',
    (next) => {
      expect(
        nextPageWithAhead(next, { ...endedAhead, local: success(local({ items: [row] })) }),
      ).toBe('PROVEN')
      expect(
        nextPageWithAhead(next, {
          ...endedAhead,
          external: success(external({ results: [row], complete: false, more: 'UNKNOWN' })),
        }),
      ).toBe('PROVEN')
    },
  )

  const failed = (status: 'ERROR' | 'TIMEOUT' | 'RATE_LIMITED'): Partial<AheadPage> => ({
    external: success(
      external({
        sources: [
          { source: 'OPEN_LIBRARY', status: 'OK' },
          { source: 'GOOGLE_BOOKS', status },
        ],
      }),
    ),
  })

  describe.each(['POSSIBLE', 'PROVEN'] as const)('after %s', (next) => {
    it.each<[string, Partial<AheadPage>]>([
      ['nothing is loaded yet', { local: undefined, external: undefined }],
      ['the external half is still loading', { external: { status: 'pending', data: undefined } }],
      ['the external half is partial', { external: success(external({ complete: false })) }],
      ['the sources still say UNKNOWN', { external: success(external({ more: 'UNKNOWN' })) }],
      ['a source answered ERROR', failed('ERROR')],
      ['a source answered TIMEOUT', failed('TIMEOUT')],
      ['a source answered RATE_LIMITED', failed('RATE_LIMITED')],
      // An HTTP failure (429 included) keeps whatever the cache held before it.
      ['the external request failed', { external: { status: 'error', data: undefined } }],
      [
        'the external request failed after a partial answer',
        { external: { status: 'error', data: external({ complete: false, more: 'UNKNOWN' }) } },
      ],
      ['the local request failed', { local: { status: 'error', data: undefined } }],
      ['the local half is still loading', { local: { status: 'pending', data: undefined } }],
      ['our catalog has more', { local: success(local({ hasMore: true })) }],
    ])('proves nothing when %s: the page’s own promise stays', (_name, overrides) => {
      expect(nextPageWithAhead(next, { ...endedAhead, ...overrides })).toBe(next)
    })
  })

  it('without the external half asked, our catalog alone decides the end', () => {
    expect(
      nextPageWithAhead('PROVEN', {
        local: success(local()),
        external: undefined,
        externalAsked: false,
      }),
    ).toBe('NONE')
  })
})
