import { SEARCH_MAX_PAGE } from '@bookswap/shared'
import type { ExternalSearchState } from './external-search-state'
import { searchPageView } from './search-page-view'

const ready = (overrides: Partial<Extract<ExternalSearchState, { status: 'ready' }>> = {}) =>
  ({
    status: 'ready',
    results: [],
    sources: [],
    page: 1,
    pageSize: 10,
    more: 'NO',
    complete: true,
    ...overrides,
  }) satisfies ExternalSearchState

const view = (overrides: Partial<Parameters<typeof searchPageView>[0]> = {}) =>
  searchPageView({
    page: 1,
    local: { ready: true, hasMore: false },
    rowCount: 3,
    external: ready(),
    ...overrides,
  })

describe('searchPageView', () => {
  it('«Далі» доводиться локальним hasMore або зовнішнім YES', () => {
    expect(view({ local: { ready: true, hasMore: true } }).next).toBe('PROVEN')
    expect(view({ external: ready({ more: 'YES' }) }).next).toBe('PROVEN')
  })

  it('«ще не питали» — не наступна сторінка', () => {
    expect(view({ external: { status: 'loading' } }).next).toBe('NONE')
    expect(view({ external: { status: 'failed', message: 'x' } }).next).toBe('NONE')
    expect(view({ local: { ready: false, hasMore: true }, external: ready() }).next).toBe('NONE')
  })

  it('UNKNOWN — Далі можливе, але не доведене (регресія №1)', () => {
    expect(view({ external: ready({ more: 'UNKNOWN' }) }).next).toBe('POSSIBLE')
  })

  it('на максимальній сторінці наступної немає (регресія №4)', () => {
    expect(
      view({
        page: SEARCH_MAX_PAGE,
        local: { ready: true, hasMore: true },
        external: ready({ more: 'YES' }),
      }).next,
    ).toBe('NONE')
  })

  it('finished — лише коли відповіли обидві половини й сторінка повна', () => {
    expect(view().finished).toBe(true)
    expect(view({ local: { ready: false, hasMore: false } }).finished).toBe(false)
    expect(view({ external: { status: 'loading' } }).finished).toBe(false)
    expect(view({ external: ready({ complete: false, more: 'UNKNOWN' }) }).finished).toBe(false)
  })
})
