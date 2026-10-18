import type {
  AddSearchEditionItem,
  AddSearchExternalItem,
  AddSearchResponse,
  AddSearchWorkItem,
} from '@bookswap/shared'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import { IDLE_EXTERNAL_SEARCH, type ExternalSearchState } from './external-search-state'
import { searchResultsView, type SearchResultsViewInput } from './search-results-view'

const ISBN = '9783161484100'
const WORK = {
  id: 'w-1',
  title: 'Книжка',
  origLang: null,
  firstPubYear: null,
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
}

const workItem: AddSearchWorkItem = {
  kind: 'WORK',
  key: 'work:w-1',
  work: WORK,
  authors: [],
  matchedOn: 'TITLE',
}

function editionItem(isbn13: string | null): AddSearchEditionItem {
  return {
    kind: 'EDITION',
    key: 'edition:e-1',
    edition: {
      id: 'e-1',
      workId: 'w-1',
      translationId: null,
      textKind: 'UNKNOWN',
      publisher: null,
      year: null,
      isbn13,
      pageCount: null,
      coverUrl: null,
      format: null,
      lang: null,
      translator: null,
      revision: 1,
    },
    work: WORK,
    authors: [],
    matchedOn: 'ISBN',
    ownership: { activeCount: 0, archivedCount: 0 },
  }
}

const externalItem: AddSearchExternalItem = {
  kind: 'EXTERNAL',
  key: 'external:GOOGLE_BOOKS:v',
  result: { id: 'GOOGLE_BOOKS:v', kind: 'EDITION', sources: ['GOOGLE_BOOKS'], title: 'Зовнішня' },
}

const local = (overrides: Partial<AddSearchResponse> = {}): AddSearchResponse => ({
  items: [],
  page: 1,
  pageSize: 10,
  total: 0,
  hasMore: false,
  ...overrides,
})

const externalReady = (
  overrides: Partial<Extract<ExternalSearchState<AddSearchExternalItem>, { status: 'ready' }>> = {},
): ExternalSearchState<AddSearchExternalItem> => ({
  status: 'ready',
  results: [],
  sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
  page: 1,
  pageSize: 10,
  more: 'NO',
  complete: true,
  ...overrides,
})

const lookupReady: KeyedState<string> = { status: 'ready', value: 'lookup-card' }
const lookupIdle: KeyedState<string> = { status: 'idle' }

/** A settled full search of "kobzar" on page 1 with nothing found anywhere. */
const settledEmpty: SearchResultsViewInput<string> = {
  enabled: true,
  typing: false,
  page: 1,
  isbn: undefined,
  fresh: local(),
  requestStatus: 'ready',
  stale: undefined,
  external: externalReady(),
  externalHeld: false,
  lookup: lookupIdle,
  localPending: false,
  ahead: { local: undefined, external: undefined, externalAsked: true },
}

const view = (overrides: Partial<SearchResultsViewInput<string>> = {}) =>
  searchResultsView({ ...settledEmpty, ...overrides })

describe('searchResultsView — response', () => {
  it('shows the fresh answer', () => {
    const fresh = local({ items: [workItem] })

    expect(view({ fresh, stale: local() }).response).toBe(fresh)
  })

  it('keeps the previous list of a typed search while the next one loads', () => {
    const stale = local({ items: [workItem] })
    const shown = view({ typing: true, fresh: undefined, stale })

    expect(shown.response).toBe(stale)
    expect(shown.items).toEqual([workItem])
  })

  it('never shows a stale answer for a search that was not typed', () => {
    expect(view({ fresh: undefined, stale: local({ items: [workItem] }) }).response).toBeUndefined()
  })
})

describe('searchResultsView — lookup card', () => {
  const lookupInput = { isbn: ISBN, lookup: lookupReady }

  it('is shown once the lookup is ready and the local answer is in', () => {
    expect(view(lookupInput).lookupCard).toBe('lookup-card')
  })

  it('waits for the local answer', () => {
    expect(view({ ...lookupInput, fresh: undefined }).lookupCard).toBeUndefined()
  })

  it('is absent while the lookup has not answered', () => {
    expect(view({ isbn: ISBN, lookup: { status: 'loading' } }).lookupCard).toBeUndefined()
  })

  it('is redundant when our own list already has that edition', () => {
    const shown = view({ ...lookupInput, fresh: local({ items: [editionItem(ISBN)] }) })

    expect(shown.redundantLookup).toBe(true)
    expect(shown.lookupCard).toBeUndefined()
  })

  it('is redundant when the external half already has that edition', () => {
    const shown = view({
      ...lookupInput,
      external: externalReady({ results: [editionItem(ISBN)] }),
    })

    expect(shown.redundantLookup).toBe(true)
    expect(shown.lookupCard).toBeUndefined()
  })

  it('is never redundant without an ISBN query', () => {
    expect(view({ fresh: local({ items: [editionItem(ISBN)] }) }).redundantLookup).toBe(false)
  })
})

describe('searchResultsView — rows and pagination', () => {
  it('counts the lookup card as a row, so the page is not empty', () => {
    expect(view({ isbn: ISBN, lookup: lookupReady }).currentHasRows).toBe(true)
    expect(view().currentHasRows).toBe(false)
  })

  it('counts local and external items', () => {
    expect(view({ fresh: local({ items: [workItem] }) }).currentHasRows).toBe(true)
    expect(view({ external: externalReady({ results: [externalItem] }) }).currentHasRows).toBe(true)
  })

  it('promises a next page only from a ready local answer with more', () => {
    expect(view({ fresh: local({ hasMore: true }) }).next).toBe('PROVEN')
    expect(view({ fresh: undefined }).next).toBe('NONE')
  })
})

describe('searchResultsView — next with the page loaded ahead', () => {
  const unknown = { external: externalReady({ more: 'UNKNOWN' }) }
  const endedAhead = {
    local: { status: 'success' as const, data: local() },
    external: {
      status: 'success' as const,
      data: { ...local(), results: [], sources: [], more: 'NO' as const, complete: true },
    },
    externalAsked: true,
  }

  it('the controls take the page ahead into account; the loading ahead does not', () => {
    const shown = view({ ...unknown, ahead: endedAhead })

    expect(shown.next).toBe('NONE')
    expect(shown.pageNext).toBe('POSSIBLE')
  })

  it('a final, empty next page withdraws the page’s own PROVEN from the controls only', () => {
    const shown = view({ external: externalReady({ more: 'YES' }), ahead: endedAhead })

    expect(shown.next).toBe('NONE')
    expect(shown.pageNext).toBe('PROVEN')
  })

  it('under a stale list the page ahead belongs to another query and is ignored', () => {
    const shown = view({
      ...unknown,
      typing: true,
      fresh: undefined,
      stale: local(),
      requestStatus: 'loading',
      ahead: endedAhead,
    })

    expect(shown.next).toBe(shown.pageNext)
  })
})

describe('searchResultsView — emptyState', () => {
  it('says plain "nothing" when both halves settled empty', () => {
    expect(view().emptyState).toBe('PLAIN')
  })

  it('is silent while the fresh answer is not in, even with a stale list on screen', () => {
    expect(view({ typing: true, fresh: undefined, stale: local() }).emptyState).toBeUndefined()
  })

  it.each<[string, Partial<SearchResultsViewInput<string>>]>([
    ['the external half is loading', { external: { status: 'loading' } }],
    ['the external page is incomplete', { external: externalReady({ complete: false }) }],
    ['the ISBN lookup is loading', { isbn: ISBN, lookup: { status: 'loading' } }],
    ['typed text waits for the debounce', { localPending: true }],
  ])('is silent while %s', (_name, overrides) => {
    expect(view(overrides).emptyState).toBeUndefined()
  })

  it('is silent when anything was found', () => {
    expect(view({ fresh: local({ items: [workItem] }) }).emptyState).toBeUndefined()
    expect(
      view({ external: externalReady({ results: [externalItem] }) }).emptyState,
    ).toBeUndefined()
    expect(view({ isbn: ISBN, lookup: lookupReady }).emptyState).toBeUndefined()
  })

  it('says "blind" when no external source could look', () => {
    expect(view({ external: { status: 'failed', message: 'x' } }).emptyState).toBe('BLIND')
    expect(
      view({
        external: externalReady({ sources: [{ source: 'GOOGLE_BOOKS', status: 'TIMEOUT' }] }),
      }).emptyState,
    ).toBe('BLIND')
  })

  it('explains that typed text too short for the sources did not ask them', () => {
    expect(view({ externalHeld: true, external: IDLE_EXTERNAL_SEARCH }).emptyState).toBe(
      'AUTO_IDLE',
    )
  })

  it('an ISBN or a too short query without asking the sources is plain "nothing"', () => {
    expect(view({ external: IDLE_EXTERNAL_SEARCH }).emptyState).toBe('PLAIN')
  })

  it('prefers "blind" over "the sources were held"', () => {
    expect(
      view({ externalHeld: true, external: { status: 'failed', message: 'x' } }).emptyState,
    ).toBe('BLIND')
  })

  it('is not said on pages past the first (that is `pageEmpty`)', () => {
    const second = view({ page: 2 })

    expect(second.emptyState).toBeUndefined()
    expect(second.pageEmpty).toBe(true)
  })
})

describe('searchResultsView — pageEmpty', () => {
  it('is false on the first page and when the page has rows', () => {
    expect(view().pageEmpty).toBe(false)
    expect(view({ page: 2, fresh: local({ items: [workItem] }) }).pageEmpty).toBe(false)
  })

  it('is false before the search has finished', () => {
    expect(view({ page: 2, fresh: undefined }).pageEmpty).toBe(false)
  })

  it('is false when the full search is not the one executed', () => {
    expect(view({ page: 2, enabled: false }).pageEmpty).toBe(false)
  })
})

describe('searchResultsView — localLoading', () => {
  it('is on while the local request is in flight', () => {
    expect(view({ fresh: undefined, requestStatus: 'loading' }).localLoading).toBe(true)
  })

  it('is on while the typed text has not reached the address', () => {
    expect(view({ localPending: true }).localLoading).toBe(true)
  })

  it('is off once the answer is in', () => {
    expect(view().localLoading).toBe(false)
  })
})

describe('searchResultsView — settled', () => {
  it('is the final page: fresh answer, both halves and the lookup done, no typed text on its way', () => {
    expect(view().settled).toBe(true)
  })

  it.each<[string, Partial<SearchResultsViewInput<string>>]>([
    ['the local answer is not in', { fresh: undefined, requestStatus: 'loading' }],
    ['only a stale list is on screen', { typing: true, fresh: undefined, stale: local() }],
    ['the external half is loading', { external: { status: 'loading' } }],
    ['the external page is incomplete', { external: externalReady({ complete: false }) }],
    ['the ISBN lookup is loading', { isbn: ISBN, lookup: { status: 'loading' } }],
    ['typed text waits for the debounce', { localPending: true }],
  ])('is false while %s', (_name, overrides) => {
    expect(view(overrides).settled).toBe(false)
  })

  it('a failed external half is final too (the empty state says so)', () => {
    expect(view({ external: { status: 'failed', message: 'x' } }).settled).toBe(true)
  })
})

describe('searchResultsView — showPagination', () => {
  it('shows for an executed search whose request has started', () => {
    expect(view().showPagination).toBe(true)
    expect(view({ fresh: undefined, requestStatus: 'loading' }).showPagination).toBe(true)
    expect(view({ fresh: undefined, requestStatus: 'error' }).showPagination).toBe(true)
  })

  it('is hidden while there is nothing requested', () => {
    expect(view({ fresh: undefined, requestStatus: 'idle' }).showPagination).toBe(false)
  })

  it('is hidden when the full search is not the one executed', () => {
    expect(view({ enabled: false }).showPagination).toBe(false)
  })

  it('is hidden under a stale list: its links would promise pages of another query', () => {
    expect(
      view({
        typing: true,
        fresh: undefined,
        stale: local({ hasMore: true }),
        requestStatus: 'loading',
      }).showPagination,
    ).toBe(false)
  })
})
