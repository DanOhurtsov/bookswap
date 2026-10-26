/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, within } from '@testing-library/react'
import type { MouseEvent, ReactNode } from 'react'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { USER_SEARCH_DELAY_MS } from '../model/user-search'
import {
  OLEKSAS,
  TRICKY,
  advance,
  createHistory,
  createSearchTestClient,
  createServer,
  me,
  pageOf,
  requestsOf,
  searchFor,
  setupUser,
  type FakeServer,
} from '../user-search.test-helpers'
import { UserSearchScreen } from './UserSearchScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockHistory = createHistory()
let mockSession: SessionState = { status: 'loading' }

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockHistory.replace, push: mockHistory.push }),
  useSearchParams: () => {
    const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react')
    const href = useSyncExternalStore(mockHistory.subscribe, mockHistory.current)

    return new URLSearchParams(href.split('?')[1] ?? '')
  },
}))

// A link navigates the fake history, as the app router would.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    onClick,
    children,
    ...rest
  }: {
    href: string
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
    children: ReactNode
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event)
        event.preventDefault()
        mockHistory.push(href)
      }}
    >
      {children}
    </a>
  ),
}))

const mockReload = jest.fn()

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: mockSession, reload: mockReload }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let server: FakeServer

const searches = () => requestsOf(apiRequest, '/users?')
const addressQuery = () =>
  new URLSearchParams(mockHistory.current().split('?')[1] ?? '').get('query')

const pageForm = () => screen.getByRole('search', { name: 'Пошук людей' })
const pageField = () => within(pageForm()).getByRole('searchbox', { name: 'Ім’я або email' })
const results = () => screen.getByRole('region', { name: 'Результати пошуку людей' })
const queryResults = () => screen.queryByRole('region', { name: 'Результати пошуку людей' })

/** Opens `href` as a fresh tab would, signed in as `viewer` unless told otherwise. */
async function openPage(href: string, { session = 'anna' as string | null } = {}) {
  mockHistory.open(href)
  mockSession =
    session === null ? { status: 'guest' } : { status: 'authenticated', user: me(session) }

  const user = setupUser()
  const client = createSearchTestClient()
  const view = render(withQueryClient(<UserSearchScreen />, client))

  await advance(0)

  return { user, client, view }
}

beforeEach(() => {
  jest.useFakeTimers()
  apiRequest.mockReset()
  mockHistory.replace.mockClear()
  mockHistory.push.mockClear()
  mockReload.mockReset()
  server = createServer()
  apiRequest.mockImplementation(server.handle)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('/friends/search — the page', () => {
  it('is for signed-in people only: a guest is sent to /login and nothing is searched', async () => {
    // The browser's own address: the guard reads it there, fragment included.
    window.history.replaceState(null, '', '/friends/search?query=%D0%9E%D0%BB')
    await openPage('/friends/search?query=Ол', { session: null })

    expect(mockHistory.replace).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent('/friends/search?query=%D0%9E%D0%BB')}`,
    )
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(searches()).toEqual([])
  })

  it('a failed session check is shown with a retry, not as a sign-out', async () => {
    mockHistory.open('/friends/search?query=Олена')
    mockSession = { status: 'error', message: 'Сервер тимчасово недоступний' }

    const user = setupUser()
    const client = createSearchTestClient()
    const view = render(withQueryClient(<UserSearchScreen />, client))

    await advance(0)

    expect(screen.getByRole('alert')).toHaveTextContent('Сервер тимчасово недоступний')
    expect(screen.queryByText(/Переадресовую/)).not.toBeInTheDocument()
    expect(mockHistory.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(searches()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(mockReload).toHaveBeenCalledTimes(1)

    // The reload succeeds: the session provider re-renders with the person.
    mockSession = { status: 'authenticated', user: me('anna') }
    view.rerender(withQueryClient(<UserSearchScreen />, client))
    await advance(0)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pageField()).toHaveValue('Олена')
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(searches()).toEqual([searchFor('Олена')])
    expect(mockHistory.replace).not.toHaveBeenCalledWith(expect.stringMatching(/^\/login/))
  })

  it('starts with one empty field, no request, and a way back to the friends', async () => {
    await openPage('/friends/search')

    expect(screen.getByRole('heading', { name: 'Пошук людей' })).toBeInTheDocument()
    expect(pageField()).toHaveValue('')
    expect(pageField()).not.toHaveFocus()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText(/Введіть щонайменше два символи/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'До друзів' })).toHaveAttribute('href', '/friends')
    expect(searches()).toEqual([])
  })

  it('opened with a query, fills the field and searches at once — the whole answer', async () => {
    await openPage('/friends/search?query=Ол')

    expect(pageField()).toHaveValue('Ол')
    expect(searches()).toEqual([searchFor('Ол')])
    // Seven people: the whole answer, not a preview.
    expect(within(results()).getAllByRole('listitem')).toHaveLength(2 + OLEKSAS.length)
    expect(within(results()).getByText('Знайдено людей: 7')).toBeInTheDocument()
  })

  it('opened with an invalid query, explains it and sends nothing', async () => {
    await openPage('/friends/search?query=%20О%20')

    expect(pageField()).toHaveValue(' О ')
    expect(screen.getByRole('alert')).toHaveTextContent('Мінімум два символи')
    expect(searches()).toEqual([])
  })

  it('keeps Cyrillic, spaces, +, @ and & intact, from the address and into it', async () => {
    const tricky = TRICKY.displayName
    const { user } = await openPage(
      `/friends/search?${new URLSearchParams({ query: tricky }).toString()}`,
    )

    expect(pageField()).toHaveValue(tricky)
    expect(searches()).toEqual([searchFor(tricky)])
    expect(within(results()).getByText(tricky)).toBeInTheDocument()

    await user.clear(pageField())
    await user.type(pageField(), 'Ян & Co +')
    await advance(USER_SEARCH_DELAY_MS)

    expect(addressQuery()).toBe('Ян & Co +')
    expect(searches()).toEqual([searchFor(tricky), searchFor('Ян & Co +')])
  })

  it('typing writes each launched search with replace, never a new history entry', async () => {
    const { user } = await openPage('/friends/search')

    await user.type(pageField(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    await user.type(pageField(), 'ена')
    await advance(USER_SEARCH_DELAY_MS)

    expect(mockHistory.push).not.toHaveBeenCalled()
    expect(mockHistory.replace.mock.calls.map(([href]) => href)).toEqual([
      `/friends/search?${new URLSearchParams({ query: 'Ол' }).toString()}`,
      `/friends/search?${new URLSearchParams({ query: 'Олена' }).toString()}`,
    ])
    expect(mockHistory.length).toBe(1)
    // The address change is ours: it does not run the search a second time.
    expect(searches()).toEqual([searchFor('Ол'), searchFor('Олена')])
  })

  it('clearing the field drops the query from the address and the results', async () => {
    const { user } = await openPage('/friends/search?query=Олена')

    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    await user.clear(pageField())

    expect(mockHistory.current()).toBe('/friends/search')
    expect(queryResults()).not.toBeInTheDocument()
  })

  it('Back and Forward restore the field and the results of each entry', async () => {
    await openPage('/friends/search?query=Олена')

    // Another search opened by a link is a real navigation: a new entry.
    act(() => mockHistory.push(pageOf('Ольга')))
    await advance(0)
    expect(pageField()).toHaveValue('Ольга')
    expect(mockHistory.length).toBe(2)

    act(() => mockHistory.back())
    await advance(0)
    expect(pageField()).toHaveValue('Олена')
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(within(results()).queryByText('Ольга Мельник')).not.toBeInTheDocument()

    act(() => mockHistory.forward())
    await advance(0)
    expect(pageField()).toHaveValue('Ольга')
    expect(within(results()).getByText('Ольга Мельник')).toBeInTheDocument()
    // Within `USER_SEARCH_STALE_MS` every entry is answered from the cache.
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Ольга')])
  })

  it('a late answer for an earlier text never replaces the current results', async () => {
    server.flags.holdSearches = true
    const { user } = await openPage('/friends/search?query=Ол')

    await user.clear(pageField())
    await user.type(pageField(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)

    const [earlier, current] = server.held

    current?.answer()
    await advance(0)
    earlier?.answer()
    earlier?.fail()
    await advance(0)

    expect(within(results()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an empty answer and a failure with a retry', async () => {
    const { user } = await openPage('/friends/search?query=Невідомий')

    expect(screen.getByText(/Нікого не знайдено/)).toBeInTheDocument()

    server.flags.failSearches = true
    await user.clear(pageField())
    await user.type(pageField(), 'Ольга{Enter}')
    await advance(0)
    expect(await screen.findByRole('button', { name: 'Спробувати ще раз' })).toBeInTheDocument()

    server.flags.failSearches = false
    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    await advance(0)
    expect(within(results()).getByText('Ольга Мельник')).toBeInTheDocument()
  })

  it('another account keeps the address query, but never the previous results or cache', async () => {
    const { user, client, view } = await openPage('/friends/search?query=Олена')
    const cached = (viewer: string) =>
      client
        .getQueryCache()
        .findAll({ queryKey: ['users', 'search', viewer] })
        .map((query) => query.queryKey)
        // An emptied field holds a disabled entry without a query.
        .filter((key) => key[3] !== undefined)

    await user.clear(pageField())
    await user.type(pageField(), 'Ольга')
    await advance(USER_SEARCH_DELAY_MS)
    expect(addressQuery()).toBe('Ольга')
    expect(cached('anna')).toEqual(
      expect.arrayContaining([
        ['users', 'search', 'anna', 'Олена'],
        ['users', 'search', 'anna', 'Ольга'],
      ]),
    )

    server.flags.holdSearches = true
    mockSession = { status: 'authenticated', user: me('bohdan') }
    view.rerender(withQueryClient(<UserSearchScreen />, client))
    await advance(0)

    // The address query stays (agreed) and is asked anew — under the new account's own key,
    // even though the previous account's answer for the same text is still fresh. Until that
    // answer arrives, nothing of the previous account's is on screen.
    expect(addressQuery()).toBe('Ольга')
    expect(pageField()).toHaveValue('Ольга')
    expect(queryResults()).not.toBeInTheDocument()
    expect(screen.queryByText('Ольга Мельник')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Шукаю людей…')

    server.held[0]?.answer()
    await advance(0)

    expect(within(results()).getByText('Ольга Мельник')).toBeInTheDocument()
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Ольга'), searchFor('Ольга')])
    expect(cached('bohdan')).toEqual([['users', 'search', 'bohdan', 'Ольга']])
  })
})
