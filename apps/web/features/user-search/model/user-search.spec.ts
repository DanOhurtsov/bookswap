import type { UserSearchResult } from '@bookswap/shared'
import { isBlankSearch, userSearchView, validateSearch } from './user-search'

const olena: UserSearchResult = {
  user: { id: 'olena', displayName: 'Олена Коваль', avatarUrl: null },
  relation: 'NONE',
}

const idleQuery = { data: undefined, error: null, isFetching: false }

describe('validateSearch', () => {
  it('searches from two characters, trimmed', () => {
    expect(validateSearch('  Ол ')).toEqual({ ok: true, query: 'Ол' })
    expect(validateSearch(' О ')).toEqual({ ok: false, errors: { form: 'Мінімум два символи' } })
  })

  it('leaves an address as typed: whether it is an exact email is the server’s call', () => {
    expect(validateSearch(' Olena@Example.com ')).toEqual({ ok: true, query: 'Olena@Example.com' })
    expect(validateSearch('olena@')).toEqual({ ok: true, query: 'olena@' })
  })

  it('treats whitespace-only text as blank, not as a search', () => {
    expect(isBlankSearch('   ')).toBe(true)
    expect(isBlankSearch(' О ')).toBe(false)
  })
})

describe('userSearchView', () => {
  const active = 'Олена'

  it('shows nothing without searchable text', () => {
    expect(userSearchView({ active: undefined, pending: false, query: idleQuery })).toEqual({
      status: 'idle',
    })
  })

  it('waits during the pause before the request', () => {
    expect(userSearchView({ active: undefined, pending: true, query: idleQuery })).toEqual({
      status: 'waiting',
    })
  })

  it('hides earlier results while the request for the current text is in flight', () => {
    expect(
      userSearchView({
        active,
        pending: false,
        query: { data: [olena], error: null, isFetching: true },
      }),
    ).toEqual({ status: 'loading' })
  })

  it('reports a failed search', () => {
    const error = new Error('Мережа недоступна')

    expect(
      userSearchView({
        active,
        pending: false,
        query: { data: undefined, error, isFetching: false },
      }),
    ).toEqual({ status: 'failed', error })
  })

  it('shows the results of the current search, including an empty list', () => {
    expect(
      userSearchView({
        active,
        pending: false,
        query: { data: [olena], error: null, isFetching: false },
      }),
    ).toEqual({ status: 'ready', results: [olena] })
    expect(
      userSearchView({
        active,
        pending: false,
        query: { data: [], error: null, isFetching: false },
      }),
    ).toEqual({ status: 'ready', results: [] })
  })
})
