/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, within } from '@testing-library/react'
import type { MouseEvent, ReactNode } from 'react'
import type { Me } from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { NavContent } from '@/components/NavBar/NavBarContent'
import {
  HEADER_RESULTS_LIMIT,
  USER_SEARCH_DELAY_MS,
  USER_SEARCH_STALE_MS,
} from '../model/user-search'
import {
  OLEKSAS,
  TRICKY,
  advance,
  createSearchTestClient,
  createServer,
  requestsOf,
  searchFor,
  setupUser,
  type FakeServer,
} from '../user-search.test-helpers'
import { UserSearch } from './UserSearch'
import { UserSearchScreen } from './UserSearchScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

/** The browser history the page sees: entries, a cursor, and who listens for changes. */
function createHistory() {
  let entries = ['/friends/search']
  let index = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const current = () => entries[index] ?? '/'

  return {
    current,
    get length() {
      return entries.length
    },
    open(href: string) {
      entries = [href]
      index = 0
    },
    subscribe(listener: () => void) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    replace: jest.fn((href: string) => {
      entries[index] = href
      notify()
    }),
    push: jest.fn((href: string) => {
      entries = [...entries.slice(0, index + 1), href]
      index += 1
      notify()
    }),
    back() {
      index -= 1
      notify()
    },
    forward() {
      index += 1
      notify()
    },
  }
}

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

jest.mock('@/components/ThemeToggle', () => ({
  ThemeToggleButton: () => <button type="button">Theme</button>,
}))

jest.mock('@/components/NavBar/NavBarAvatar', () => ({
  NavBarAvatar: () => <span>Профіль</span>,
}))

jest.mock('@/components/NavBar/NavBarNotifications', () => ({
  NavBarNotifications: () => <span>Сповіщення</span>,
}))

const mockReload = jest.fn()

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: mockSession, reload: mockReload }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let server: FakeServer

const searches = () => requestsOf(apiRequest, '/users?')
const posts = () => requestsOf(apiRequest, '/friends/requests', 'POST')
const addressQuery = () =>
  new URLSearchParams(mockHistory.current().split('?')[1] ?? '').get('query')

const me = (id: string): Me => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  displayName: id,
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: false,
  createdAt: '2026-01-01T00:00:00.000Z',
})

const pageForm = () => screen.getByRole('search', { name: 'Пошук людей' })
const pageField = () => within(pageForm()).getByRole('searchbox', { name: 'Ім’я або email' })
const results = () => screen.getByRole('region', { name: 'Результати пошуку людей' })
const queryResults = () => screen.queryByRole('region', { name: 'Результати пошуку людей' })
const headerForm = () => screen.getByRole('search', { name: 'Швидкий пошук людей' })
const headerField = () => within(headerForm()).getByRole('searchbox', { name: 'Ім’я або email' })

/** Opens `href` as a fresh tab would, signed in as `viewer` unless told otherwise. */
async function openPage(href: string, { header = false, session = 'anna' as string | null } = {}) {
  mockHistory.open(href)
  mockSession =
    session === null ? { status: 'guest' } : { status: 'authenticated', user: me(session) }

  const user = setupUser()
  const client = createSearchTestClient()
  const view = render(
    withQueryClient(
      <>
        {header && <UserSearch viewerId="anna" />}
        <UserSearchScreen />
      </>,
      client,
    ),
  )

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
    await openPage('/friends/search?query=Ол', { session: null })

    expect(mockHistory.replace).toHaveBeenCalledWith('/login')
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
    expect(mockHistory.replace).not.toHaveBeenCalledWith('/login')
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
    // Seven people: more than the header would show.
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
    const { user } = await openPage('/friends/search?query=Олена', { header: true })

    // The header's «Показати всі» is a real navigation: a new entry.
    await user.type(headerField(), 'Ольга')
    await advance(USER_SEARCH_DELAY_MS)
    await user.click(screen.getByRole('link', { name: 'Показати всі' }))
    await advance(0)
    expect(pageField()).toHaveValue('Ольга')

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

  it('another account keeps the address query, but not the header search or the cache', async () => {
    mockHistory.open('/friends/search?query=Олена')
    mockSession = { status: 'authenticated', user: me('anna') }

    const user = setupUser()
    const client = createSearchTestClient()
    const cached = (viewer: string) =>
      client
        .getQueryCache()
        .findAll({ queryKey: ['users', 'search', viewer] })
        .map((query) => query.queryKey)
        // A closed header search with no text holds a disabled entry without a query.
        .filter((key) => key[3] !== undefined)
    const app = (session: SessionState) =>
      withQueryClient(
        <>
          <NavContent state={session} />
          <UserSearchScreen />
        </>,
        client,
      )
    const view = render(app(mockSession))

    await advance(0)
    await user.type(headerField(), 'Ольга')
    await advance(USER_SEARCH_DELAY_MS)
    expect(cached('anna')).toEqual(
      expect.arrayContaining([
        ['users', 'search', 'anna', 'Олена'],
        ['users', 'search', 'anna', 'Ольга'],
      ]),
    )

    mockSession = { status: 'authenticated', user: me('bohdan') }
    view.rerender(app(mockSession))
    await advance(0)

    // The header starts empty and closed for the new account.
    expect(headerField()).toHaveValue('')
    expect(screen.getAllByRole('region', { name: 'Результати пошуку людей' })).toHaveLength(1)
    // The address query stays (agreed) and is asked anew — under the new account's own key,
    // even though the previous account's answer for the same text is still fresh.
    expect(pageField()).toHaveValue('Олена')
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Ольга'), searchFor('Олена')])
    expect(cached('bohdan')).toEqual([['users', 'search', 'bohdan', 'Олена']])
  })
})

describe('/friends/search — with the header search mounted', () => {
  it('«Показати всі» opens the page with the field filled and the full answer loaded', async () => {
    const { user } = await openPage('/friends/search', { header: true })

    await user.type(headerField(), '  Ол ')
    await advance(USER_SEARCH_DELAY_MS)
    expect(
      within(screen.getByRole('region', { name: 'Результати пошуку людей' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(HEADER_RESULTS_LIMIT)

    await user.click(screen.getByRole('link', { name: 'Показати всі' }))
    await advance(0)

    expect(mockHistory.current()).toBe(
      `/friends/search?${new URLSearchParams({ query: 'Ол' }).toString()}`,
    )
    expect(pageField()).toHaveValue('Ол')
    // The header panel closed; the only results on screen are the page's — all seven.
    expect(screen.getAllByRole('region', { name: 'Результати пошуку людей' })).toHaveLength(1)
    expect(within(results()).getAllByRole('listitem')).toHaveLength(7)
    // The header's answer is fresh: the page shows it without a second request.
    expect(searches()).toEqual([searchFor('Ол')])
  })

  it('an answer older than the freshness window is asked again on the page', async () => {
    const { user } = await openPage('/friends/search', { header: true })

    await user.type(headerField(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    await advance(USER_SEARCH_STALE_MS)
    await user.click(screen.getByRole('link', { name: 'Показати всі' }))
    await advance(0)

    expect(searches()).toEqual([searchFor('Ол'), searchFor('Ол')])
    expect(within(results()).getAllByRole('listitem')).toHaveLength(7)
  })

  it('one action updates both, and the pending one cannot be repeated from the other', async () => {
    const { user } = await openPage('/friends/search?query=Олена', { header: true })

    await user.type(headerField(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    const [, page] = screen.getAllByRole('region', { name: 'Результати пошуку людей' })

    const searchesBefore = searches().length

    server.flags.holdActions = true
    await user.click(within(page as HTMLElement).getByRole('button', { name: 'Додати' }))

    // The click on the page closed the header panel; back in its field, it reopens.
    await user.click(headerField())
    const [headerPanel] = screen.getAllByRole('region', { name: 'Результати пошуку людей' })
    const headerButton = within(headerPanel as HTMLElement).getByRole('button', {
      name: 'Надсилаю…',
    })

    expect(headerButton).toBeDisabled()
    await user.click(headerButton)
    expect(posts()).toHaveLength(1)

    server.heldActions[0]?.answer()
    await advance(0)

    for (const region of screen.getAllByRole('region', { name: 'Результати пошуку людей' })) {
      expect(within(region).getByText('Запит надіслано — чекає на відповідь')).toBeInTheDocument()
    }
    // Both searches show the same text: one cache entry, asked once, and once more for the action.
    expect(searchesBefore).toBe(1)
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    expect(posts()).toHaveLength(1)
  })
})
