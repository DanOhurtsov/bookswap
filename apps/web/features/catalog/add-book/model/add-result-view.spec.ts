import type { AddSearchEditionItem, ExternalSearchResult } from '@bookswap/shared'
import { addResultView } from './add-result-view'

const WORK = {
  id: 'w-1',
  title: 'Кобзар',
  origLang: 'uk',
  firstPubYear: 1840,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

const EDITION_ITEM: AddSearchEditionItem = {
  kind: 'EDITION',
  key: 'edition:e-1',
  edition: {
    id: 'e-1',
    workId: 'w-1',
    translationId: null,
    publisher: 'Наука',
    year: 2019,
    isbn13: '9783161484100',
    pageCount: 320,
    coverUrl: null,
    format: 'HARDCOVER',
    textKind: 'ORIGINAL',
    lang: 'uk',
    translator: null,
    revision: 1,
  },
  work: WORK,
  authors: [{ id: 'a-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 }],
  matchedOn: 'TITLE',
  ownership: { activeCount: 0, archivedCount: 1 },
}

function external(over: Partial<ExternalSearchResult> = {}): ExternalSearchResult {
  return {
    id: 'GOOGLE_BOOKS:vol-1',
    kind: 'EDITION',
    sources: ['GOOGLE_BOOKS'],
    title: 'Назва',
    authors: ['Автор'],
    ...over,
  }
}

describe('addResultView — our edition', () => {
  const view = addResultView({ kind: 'EDITION', item: EDITION_ITEM })

  it('the edition facts in order, the language by its Ukrainian name', () => {
    expect(view.facts).toEqual([
      { label: 'Мова', value: 'українська' },
      { label: 'Видавництво', value: 'Наука' },
      { label: 'Рік видання', value: '2019' },
      { label: 'ISBN', value: '9783161484100' },
    ])
  })

  it('one press adds THIS edition, in the slot of all its identities', () => {
    expect(view.quickAdd).toEqual({
      identities: ['edition:e-1', 'isbn:9783161484100'],
      target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
    })
    expect(view.ownership).toEqual({ activeCount: 0, archivedCount: 1 })
  })

  it('refining keeps the edition and its work, so nothing is created twice', () => {
    expect(Object.fromEntries(view.refine)).toEqual({ editionId: 'e-1', workId: 'w-1' })
  })
})

describe('addResultView — our work without an edition', () => {
  const view = addResultView({
    kind: 'WORK',
    item: { kind: 'WORK', key: 'work:w-1', work: WORK, authors: [], matchedOn: 'TITLE' },
  })

  it('nothing to add; refining creates an edition of this work', () => {
    expect(view.quickAdd).toBeUndefined()
    expect(view.refineReason).toBe('WORK')
    expect(Object.fromEntries(view.refine)).toEqual({ workId: 'w-1' })
  })

  it('the first publication is labelled as such, never as the edition year; no cover made up', () => {
    expect(view.facts).toEqual([{ label: 'Уперше видано', value: '1840' }])
    expect(view.coverUrl).toBeUndefined()
    expect(view.authors).toBeUndefined()
  })
})

describe('addResultView — an external edition', () => {
  const full = external({
    isbn13: '9783161484100',
    language: 'en',
    publisher: 'Видавець',
    publishedYear: 2019,
    firstPublishedYear: 1937,
    pageCount: 320,
    format: 'PAPERBACK',
    coverUrl: 'https://covers.example/1.jpg',
  })

  it('adds by identity only and keeps the source attribution', () => {
    const view = addResultView({ kind: 'EXTERNAL', result: full })

    expect(view.quickAdd?.target).toEqual({
      kind: 'EXTERNAL_EDITION',
      source: 'GOOGLE_BOOKS',
      externalId: 'vol-1',
      isbn13: '9783161484100',
    })
    expect(view.source).toEqual({ kind: 'EXTERNAL', sources: ['GOOGLE_BOOKS'] })
  })

  it('refining carries every known field, the work year and the edition year apart', () => {
    const refine = addResultView({ kind: 'EXTERNAL', result: full }).refine

    expect(Object.fromEntries(refine)).toEqual({
      record: 'GOOGLE_BOOKS:vol-1',
      title: 'Назва',
      author: 'Автор',
      firstPubYear: '1937',
      isbn: '9783161484100',
      lang: 'en',
      publisher: 'Видавець',
      year: '2019',
      pageCount: '320',
      format: 'PAPERBACK',
      coverUrl: 'https://covers.example/1.jpg',
    })
  })

  it('shows the work year next to the edition year, each under its own label', () => {
    expect(addResultView({ kind: 'EXTERNAL', result: full }).facts).toEqual([
      { label: 'Мова', value: 'англійська' },
      { label: 'Видавництво', value: 'Видавець' },
      { label: 'Рік видання', value: '2019' },
      { label: 'ISBN', value: '9783161484100' },
      { label: 'Уперше видано', value: '1937' },
    ])
  })

  it('an edition with no identity the server can be pointed at offers only refining', () => {
    const view = addResultView({
      kind: 'EXTERNAL',
      result: external({ id: 'OPEN_LIBRARY:OL1M', sources: ['OPEN_LIBRARY'], publisher: 'В' }),
    })

    expect(view.quickAdd).toBeUndefined()
    expect(view.refineReason).toBe('NO_IDENTITY')
    expect(view.refine.get('publisher')).toBe('В')
  })
})

describe('addResultView — an external work record', () => {
  it('only work-level data: no ISBN, publisher, edition year or cover of some printing', () => {
    const view = addResultView({
      kind: 'EXTERNAL',
      result: external({
        id: 'OPEN_LIBRARY:OL1W',
        kind: 'WORK',
        sources: ['OPEN_LIBRARY'],
        authors: ['Один', 'Два'],
        firstPublishedYear: 1937,
        isbn13: '9783161484100',
        publisher: 'Агрегат',
        publishedYear: 2001,
        coverUrl: 'https://covers.example/w.jpg',
      }),
    })

    expect(view.quickAdd).toBeUndefined()
    expect(view.refineReason).toBe('WORK')
    expect([...view.refine]).toEqual([
      ['title', 'Назва'],
      ['firstPubYear', '1937'],
      ['author', 'Один'],
      ['author', 'Два'],
      // Not data for the form: which record it was opened from, so two records are two intents.
      ['record', 'OPEN_LIBRARY:OL1W'],
    ])
    expect(view.facts).toEqual([{ label: 'Уперше видано', value: '1937' }])
  })
})

describe('addResultView — the ISBN lookup', () => {
  it('adds by the searched ISBN and carries everything the source said into refining', () => {
    const view = addResultView({
      kind: 'LOOKUP',
      isbn: '9783161484100',
      lookup: {
        title: 'Знайдена',
        publishedYear: 2020,
        language: 'uk',
        pageCount: 100,
        source: 'OPEN_LIBRARY',
      },
    })

    expect(view.quickAdd).toEqual({
      identities: ['isbn:9783161484100'],
      target: { kind: 'EXTERNAL_EDITION', isbn13: '9783161484100' },
    })
    expect(view.source).toEqual({ kind: 'LOOKUP', source: 'OPEN_LIBRARY' })
    expect(Object.fromEntries(view.refine)).toEqual({
      title: 'Знайдена',
      isbn: '9783161484100',
      lang: 'uk',
      year: '2020',
      pageCount: '100',
    })
  })
})
