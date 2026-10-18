import { manualPrefillParams } from './manual-form'
import {
  addBookModeOf,
  backToSearchHref,
  clearedHref,
  correctedSearchHref,
  manualFormHref,
  manualHref,
  manualIntentOf,
  opensLibraryAfterAdd,
  screenKeyOf,
} from './search-address-urls'

describe('correctedSearchHref', () => {
  it('leaves a sound search address alone', () => {
    expect(correctedSearchHref(new URLSearchParams('q=kobzar&page=3&pageSize=24'))).toBeUndefined()
  })

  it('an old suggestions link (auto=1) becomes the full search of the same query, other parameters kept', () => {
    expect(correctedSearchHref(new URLSearchParams('q=kobzar&auto=1&keep=1'))).toBe(
      '/catalog/new?q=kobzar&keep=1',
    )
    expect(correctedSearchHref(new URLSearchParams('q=kobzar&page=2&pageSize=24&auto=1'))).toBe(
      '/catalog/new?q=kobzar&page=2&pageSize=24',
    )
  })

  it('garbage in page or pageSize — the first page of the default size, without the old flag', () => {
    expect(correctedSearchHref(new URLSearchParams('q=kobzar&page=0&pageSize=7&auto=1'))).toBe(
      '/catalog/new?q=kobzar',
    )
  })

  it('an address without a query is not corrected', () => {
    expect(correctedSearchHref(new URLSearchParams('auto=1&page=x'))).toBeUndefined()
  })
})

describe('clearedHref', () => {
  it('drops the search state and keeps everything else', () => {
    const current = new URLSearchParams('q=kobzar&page=2&pageSize=24&auto=1&keep=1')

    expect(clearedHref(current)).toBe('/catalog/new?keep=1')
  })

  it('is the bare path when nothing else is left', () => {
    expect(clearedHref(new URLSearchParams('q=kobzar&auto=1'))).toBe('/catalog/new')
  })

  it('does not mutate the current parameters', () => {
    const current = new URLSearchParams('q=kobzar&auto=1')

    clearedHref(current)

    expect(current.toString()).toBe('q=kobzar&auto=1')
  })
})

describe('manualHref', () => {
  const base = { parameters: new URLSearchParams(), isbn: undefined, query: undefined }

  it('opens an empty form when nothing is searched', () => {
    expect(manualHref(base)).toBe('/catalog/new?mode=manual')
  })

  it('carries an ISBN instead of a title, even when a text query is active', () => {
    expect(manualHref({ ...base, isbn: '9783161484100', query: 'x' })).toBe(
      '/catalog/new?mode=manual&isbn=9783161484100',
    )
  })

  it('carries the executed query', () => {
    expect(manualHref({ ...base, query: 'kobzar' })).toBe('/catalog/new?mode=manual&title=kobzar')
  })

  it('carries the search context next to the prefill, not instead of it', () => {
    const parameters = new URLSearchParams('q=kobzar&page=2&pageSize=24')

    expect(manualHref({ ...base, parameters, query: 'kobzar' })).toBe(
      '/catalog/new?mode=manual&title=kobzar&q=kobzar&page=2&pageSize=24',
    )
  })
})

describe('manualFormHref', () => {
  it('copies q, page and pageSize as they are and nothing else — not the old auto flag either', () => {
    const current = new URLSearchParams('q=kob&auto=1&external=tok&keep=1&page=3&pageSize=24')

    expect(manualFormHref(new URLSearchParams({ workId: 'w-1' }), current)).toBe(
      '/catalog/new?mode=manual&workId=w-1&q=kob&page=3&pageSize=24',
    )
  })

  it('keeps repeated prefill parameters', () => {
    const prefill = new URLSearchParams([
      ['title', 'T'],
      ['author', 'A'],
      ['author', 'B'],
    ])

    expect(manualFormHref(prefill, new URLSearchParams())).toBe(
      '/catalog/new?mode=manual&title=T&author=A&author=B',
    )
  })

  it('does not mutate its inputs', () => {
    const prefill = new URLSearchParams('title=T')
    const current = new URLSearchParams('q=kobzar')

    manualFormHref(prefill, current)

    expect(prefill.toString()).toBe('title=T')
    expect(current.toString()).toBe('q=kobzar')
  })
})

describe('backToSearchHref', () => {
  it('returns to the query, page and size, dropping the form parameters', () => {
    const current = new URLSearchParams(
      'mode=manual&title=edited&isbn=9783161484100&author=A&firstPubYear=1937&workId=w-1&q=kobzar&page=2&pageSize=24',
    )

    expect(backToSearchHref(current)).toBe('/catalog/new?q=kobzar&page=2&pageSize=24')
  })

  it('an old form link from suggestions (auto=1) returns to the search; the page then drops the flag', () => {
    expect(backToSearchHref(new URLSearchParams('mode=manual&title=kob&q=kob&auto=1'))).toBe(
      '/catalog/new?q=kob&auto=1',
    )
  })

  it('returns to the query, not to the edited title', () => {
    expect(backToSearchHref(new URLSearchParams('mode=manual&title=Інша&q=кобзар'))).toBe(
      `/catalog/new?${new URLSearchParams({ q: 'кобзар' }).toString()}`,
    )
  })

  it('opened directly, returns to an empty search', () => {
    expect(backToSearchHref(new URLSearchParams('mode=manual'))).toBe('/catalog/new?q=')
  })

  it('is a round trip with manualFormHref', () => {
    const search = new URLSearchParams('q=kobzar&page=3&pageSize=24')

    expect(
      backToSearchHref(
        new URLSearchParams(manualFormHref(new URLSearchParams('title=x'), search).split('?')[1]),
      ),
    ).toBe(`/catalog/new?${search.toString()}`)
  })
})

describe('backToSearchHref — BS-114 prefill', () => {
  it('drops the refined edition and every prefilled field, keeping only the search', () => {
    const prefill = manualPrefillParams({
      title: 'Назва',
      authors: ['Автор'],
      firstPubYear: 1937,
      isbn: '9783161484100',
      lang: 'uk',
      publisher: 'Видавець',
      year: 2019,
      pageCount: 320,
      format: 'HARDCOVER',
      coverUrl: 'https://covers.example/1.jpg',
    })
    const search = new URLSearchParams('q=кобзар&page=2&pageSize=24')
    const form = (extra: URLSearchParams): URLSearchParams =>
      new URLSearchParams(manualFormHref(extra, search).split('?')[1])

    expect(backToSearchHref(form(prefill))).toBe(backToSearchHref(search))
    expect(backToSearchHref(form(new URLSearchParams({ editionId: 'e-1', workId: 'w-1' })))).toBe(
      backToSearchHref(search),
    )
  })
})

describe('addBookModeOf', () => {
  it('no form parameters — the search', () => {
    expect(addBookModeOf(new URLSearchParams('q=кобзар'))).toEqual({ kind: 'search' })
  })

  it('mode=manual — the manual form; workId alone — a new edition of that work', () => {
    expect(addBookModeOf(new URLSearchParams('mode=manual'))).toEqual({
      kind: 'manual',
      presetWorkId: null,
      form: '',
    })
    expect(addBookModeOf(new URLSearchParams('workId=w-1'))).toEqual({
      kind: 'manual',
      presetWorkId: 'w-1',
      form: 'workId=w-1',
    })
  })

  it('editionId with its workId — refining that existing edition, also next to mode=manual', () => {
    expect(addBookModeOf(new URLSearchParams('mode=manual&editionId=e-1&workId=w-1'))).toEqual({
      kind: 'edition',
      editionId: 'e-1',
      workId: 'w-1',
    })
  })

  it('editionId without a workId is not enough to name an edition: the manual form', () => {
    expect(addBookModeOf(new URLSearchParams('mode=manual&editionId=e-1'))).toEqual({
      kind: 'manual',
      presetWorkId: null,
      form: 'editionId=e-1',
    })
  })
})

describe('screenKeyOf / opensLibraryAfterAdd', () => {
  const search = screenKeyOf({ kind: 'search' }, 0)
  const manual = screenKeyOf({ kind: 'manual', presetWorkId: null, form: 'title=x' }, 0)
  const edition = screenKeyOf({ kind: 'edition', editionId: 'e-1', workId: 'w-1' }, 0)

  it('the search has no key: a success in its dialog never leaves it', () => {
    expect(search).toBeUndefined()
    expect(opensLibraryAfterAdd(search, search)).toBe(false)
  })

  it('a form opens the library for its own add while it is still on screen', () => {
    expect(opensLibraryAfterAdd(manual, manual)).toBe(true)
    expect(opensLibraryAfterAdd(edition, edition)).toBe(true)
  })

  it('a late answer after the person moved on does not carry them away', () => {
    expect(opensLibraryAfterAdd(manual, search)).toBe(false)
    expect(opensLibraryAfterAdd(edition, search)).toBe(false)
    expect(
      opensLibraryAfterAdd(
        manual,
        screenKeyOf({ kind: 'manual', presetWorkId: null, form: 'title=x' }, 1),
      ),
    ).toBe(false)
    expect(
      opensLibraryAfterAdd(
        edition,
        screenKeyOf({ kind: 'edition', editionId: 'e-2', workId: 'w-1' }, 0),
      ),
    ).toBe(false)
  })

  it('an operation without a known screen (an old pending entry) opens nothing', () => {
    expect(opensLibraryAfterAdd(undefined, manual)).toBe(false)
  })
})

describe('manualIntentOf — what one manual form was opened for (рев’ю BS-114)', () => {
  const intentOf = (query: string): string => {
    const mode = addBookModeOf(new URLSearchParams(query))

    if (mode.kind !== 'manual') throw new Error('not the manual form')

    return manualIntentOf(mode.form, 0)
  }

  it('another record or another prefill is another intent, even under the same title', () => {
    expect(intentOf('mode=manual&title=A&record=GOOGLE_BOOKS:1')).not.toBe(
      intentOf('mode=manual&title=A&record=GOOGLE_BOOKS:2'),
    )
    expect(intentOf('mode=manual&title=A&isbn=9783161484100')).not.toBe(
      intentOf('mode=manual&title=A&isbn=9780306406157'),
    )
    expect(intentOf('mode=manual&title=A')).not.toBe(intentOf('mode=manual&title=B'))
  })

  it('coming back to the same form is the same intent: the search context is not part of it', () => {
    expect(intentOf('mode=manual&title=A&record=OL:1&q=a&page=2')).toBe(
      intentOf('mode=manual&record=OL:1&title=A&q=b&auto=1'),
    )
  })

  it('«Додати ще одну книжку» turns the same form into a new intent', () => {
    expect(manualIntentOf('title=A', 0)).not.toBe(manualIntentOf('title=A', 1))
  })

  it('the way back drops the record together with the rest of the form', () => {
    expect(backToSearchHref(new URLSearchParams('mode=manual&record=OL:1&title=A&q=a'))).toBe(
      '/catalog/new?q=a',
    )
  })
})
