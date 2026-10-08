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
  autoActive: false,
  page: 1,
  isbn: undefined,
  fresh: local(),
  requestStatus: 'ready',
  stale: undefined,
  external: externalReady(),
  lookup: lookupIdle,
  localPending: false,
}

const view = (overrides: Partial<SearchResultsViewInput<string>> = {}) =>
  searchResultsView({ ...settledEmpty, ...overrides })

describe('searchResultsView — response', () => {
  it('shows the fresh answer', () => {
    const fresh = local({ items: [workItem] })

    expect(view({ fresh, stale: local() }).response).toBe(fresh)
  })

  it('keeps the previous suggestions while the next ones load', () => {
    const stale = local({ items: [workItem] })
    const shown = view({ autoActive: true, fresh: undefined, stale })

    expect(shown.response).toBe(stale)
    expect(shown.items).toEqual([workItem])
  })

  it('never shows a stale answer outside suggestion mode', () => {
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

describe('searchResultsView — emptyState', () => {
  it('says plain "nothing" when both halves settled empty', () => {
    expect(view().emptyState).toBe('PLAIN')
  })

  it('is silent while the fresh answer is not in, even with a stale list on screen', () => {
    expect(view({ autoActive: true, fresh: undefined, stale: local() }).emptyState).toBeUndefined()
  })

  it.each<[string, Partial<SearchResultsViewInput<string>>]>([
    ['the external half is loading', { external: { status: 'loading' } }],
    ['the external page is incomplete', { external: externalReady({ complete: false }) }],
    ['the ISBN lookup is loading', { isbn: ISBN, lookup: { status: 'loading' } }],
    ['suggestions wait for the debounce', { autoActive: true, localPending: true }],
  ])('is silent while %s', (_name, overrides) => {
    expect(view(overrides).emptyState).toBeUndefined()
  })

  it('ignores the debounce outside suggestion mode', () => {
    expect(view({ localPending: true }).emptyState).toBe('PLAIN')
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

  it('explains that suggestions did not ask the external catalogs yet', () => {
    expect(view({ autoActive: true, external: IDLE_EXTERNAL_SEARCH }).emptyState).toBe('AUTO_IDLE')
  })

  it('prefers "blind" over "suggestions are idle"', () => {
    expect(
      view({ autoActive: true, external: { status: 'failed', message: 'x' } }).emptyState,
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

describe('searchResultsView — showUnavailableNotice', () => {
  const suggestions = { autoActive: true, fresh: local({ items: [workItem] }) }

  it('shows one neutral line when a source failed or did not answer in suggestion mode', () => {
    expect(
      view({ ...suggestions, external: { status: 'failed', message: 'x' } }).showUnavailableNotice,
    ).toBe(true)
    expect(
      view({
        ...suggestions,
        external: externalReady({ sources: [{ source: 'GOOGLE_BOOKS', status: 'RATE_LIMITED' }] }),
      }).showUnavailableNotice,
    ).toBe(true)
  })

  it('is absent when every source answered', () => {
    expect(view({ ...suggestions, external: externalReady() }).showUnavailableNotice).toBe(false)
  })

  it('is absent outside suggestion mode: the full search has its own status', () => {
    expect(view({ external: { status: 'failed', message: 'x' } }).showUnavailableNotice).toBe(false)
  })

  it('yields to the empty-state sentence, which already says the sources did not answer', () => {
    const empty = view({
      autoActive: true,
      external: { status: 'failed', message: 'x' },
    })

    expect(empty.emptyState).toBe('BLIND')
    expect(empty.showUnavailableNotice).toBe(false)
  })
})

describe('searchResultsView — localLoading', () => {
  it('is on while the local request is in flight', () => {
    expect(view({ fresh: undefined, requestStatus: 'loading' }).localLoading).toBe(true)
  })

  it('is on in suggestion mode while the typed text has not reached the address', () => {
    expect(view({ autoActive: true, localPending: true }).localLoading).toBe(true)
  })

  it('ignores the pending text outside suggestion mode', () => {
    expect(view({ localPending: true }).localLoading).toBe(false)
  })

  it('is off once the answer is in', () => {
    expect(view().localLoading).toBe(false)
  })
})

describe('searchResultsView — showAllResults', () => {
  it('is offered once the suggestions answer is in', () => {
    expect(view({ autoActive: true }).showAllResults).toBe(true)
  })

  it('is not offered on a stale list while the next answer loads', () => {
    expect(
      view({ autoActive: true, fresh: undefined, stale: local(), requestStatus: 'loading' })
        .showAllResults,
    ).toBe(false)
  })

  it('is not offered outside suggestion mode', () => {
    expect(view().showAllResults).toBe(false)
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
    expect(view({ enabled: false, autoActive: true }).showPagination).toBe(false)
  })
})
