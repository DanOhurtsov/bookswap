/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import type { Me } from '@bookswap/shared'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { useFriends } from '@/app/lib/use-friends'
import { NavContent } from '@/components/NavBar/NavBarContent'
import { HEADER_RESULTS_LIMIT, USER_SEARCH_DELAY_MS } from '../model/user-search'
import {
  NETWORK_ERROR,
  advance,
  createSearchTestClient,
  createServer,
  requestsOf,
  searchFor,
  setupUser,
  type FakeServer,
} from '../user-search.test-helpers'
import { UserSearch } from './UserSearch'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/components/ThemeToggle', () => ({
  ThemeToggleButton: () => <button type="button">Theme</button>,
}))

jest.mock('@/components/NavBar/NavBarAvatar', () => ({
  NavBarAvatar: () => <span>Профіль</span>,
}))

jest.mock('@/components/NavBar/NavBarNotifications', () => ({
  NavBarNotifications: () => <span>Сповіщення</span>,
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let server: FakeServer

const requests = (prefix: string, method = 'GET') => requestsOf(apiRequest, prefix, method)
const searches = () => requests('/users?')

/** The friends page's legacy reader: proves an action here reaches the lists mounted elsewhere. */
function FriendsProbe() {
  useFriends()

  return null
}

function renderSearch() {
  const user = setupUser()

  render(
    withQueryClient(
      <>
        <button type="button">Перед пошуком</button>
        <UserSearch viewerId="me" />
        <FriendsProbe />
        <button type="button">Поза пошуком</button>
      </>,
      createSearchTestClient(),
    ),
  )

  return user
}

const field = () => screen.getByRole('searchbox', { name: 'Ім’я або email' })
const panel = () => screen.getByRole('region', { name: 'Результати пошуку людей' })
const queryPanel = () => screen.queryByRole('region', { name: 'Результати пошуку людей' })
const submitButton = () => screen.getByRole('button', { name: /^(Знайти|Шукаю…)$/ })

beforeEach(() => {
  jest.useFakeTimers()
  apiRequest.mockReset()
  server = createServer()
  apiRequest.mockImplementation(server.handle)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('UserSearch — searching while typing', () => {
  it('searches once with one query, the delay after the last keystroke', async () => {
    const user = renderSearch()

    expect(field()).not.toHaveFocus()
    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS - 1)
    expect(searches()).toEqual([])

    await advance(1)
    expect(searches()).toEqual([searchFor('Олена')])
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(within(panel()).queryByText('Ольга Мельник')).not.toBeInTheDocument()
  })

  it('sends a complete address as the same single query and shows the exact match', async () => {
    const user = renderSearch()

    await user.type(field(), 'olena@example.com')
    await advance(USER_SEARCH_DELAY_MS)

    expect(searches()).toEqual([searchFor('olena@example.com')])
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('sends nothing for blank or one-character text; only «Знайти» explains why', async () => {
    const user = renderSearch()

    await user.type(field(), '   ')
    await user.keyboard('{Enter}')
    await advance(1000)
    expect(queryPanel()).not.toBeInTheDocument()

    await user.clear(field())
    await user.type(field(), 'О')
    await advance(1000)
    expect(searches()).toEqual([])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(submitButton())
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Мінімум два символи')
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(searches()).toEqual([])
  })

  it('clearing the field drops the results, the pending search, the errors and the panel', async () => {
    const user = renderSearch()

    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()

    await user.clear(field())
    expect(queryPanel()).not.toBeInTheDocument()

    await user.type(field(), 'Ол')
    await user.clear(field())
    await advance(1000)
    expect(searches()).toEqual([searchFor('Олена')])

    await user.type(field(), 'О{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Мінімум два символи')
    await user.clear(field())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(field()).not.toHaveAttribute('aria-invalid')
  })

  it('Enter and «Знайти» search at once, without a delayed duplicate', async () => {
    const user = renderSearch()

    await user.type(field(), 'Олена{Enter}')
    expect(searches()).toEqual([searchFor('Олена')])
    await advance(1000)
    expect(searches()).toEqual([searchFor('Олена')])

    await user.type(field(), ' Коваль')
    await user.click(submitButton())
    await advance(1000)
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена Коваль')])
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('Enter on the search already shown asks again, despite the fresh cache', async () => {
    const user = renderSearch()

    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    await user.keyboard('{Enter}')
    await advance(0)

    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('returning to a text within the freshness window reuses its answer', async () => {
    const user = renderSearch()

    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    await user.clear(field())
    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)

    expect(searches()).toEqual([searchFor('Олена')])
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('keeps the field editable while searching and lets a new text run at once', async () => {
    const user = renderSearch()

    server.flags.holdSearches = true
    await user.type(field(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    expect(within(panel()).getByText('Шукаю людей…')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
    expect(field()).toBeEnabled()

    await user.type(field(), 'ена{Enter}')
    expect(field()).toHaveValue('Олена')
    expect(searches()).toEqual([searchFor('Ол'), searchFor('Олена')])
  })

  it('a late answer or error for an earlier text never replaces the current results', async () => {
    const user = renderSearch()

    server.flags.holdSearches = true
    await user.type(field(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    await user.type(field(), 'ена')
    await advance(USER_SEARCH_DELAY_MS)

    const [earlier, current] = server.held

    current?.answer()
    await advance(0)
    earlier?.answer()
    earlier?.fail()
    await advance(0)

    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(within(panel()).queryByText('Ольга Мельник')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('an answer arriving after the field was cleared is not shown', async () => {
    const user = renderSearch()

    server.flags.holdSearches = true
    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    await user.clear(field())
    server.held[0]?.answer()
    await advance(0)

    expect(queryPanel()).not.toBeInTheDocument()
    expect(screen.queryByText('Олена Коваль')).not.toBeInTheDocument()
  })

  it('shows an empty result and a failed search with its own retry', async () => {
    const user = renderSearch()

    await user.type(field(), 'Невідомий')
    await advance(USER_SEARCH_DELAY_MS)
    expect(within(panel()).getByText(/Нікого не знайдено/)).toBeInTheDocument()

    server.flags.failSearches = true
    await user.clear(field())
    await user.type(field(), 'Ольга')
    await advance(USER_SEARCH_DELAY_MS)
    expect(within(panel()).getByRole('alert')).toHaveTextContent(NETWORK_ERROR)

    server.flags.failSearches = false
    await user.click(within(panel()).getByRole('button', { name: 'Спробувати ще раз' }))
    await advance(0)
    expect(within(panel()).getByText('Ольга Мельник')).toBeInTheDocument()
  })
})

describe('UserSearch — the results panel', () => {
  async function openWithResults(user: ReturnType<typeof setupUser>, text = 'Ол') {
    await user.type(field(), text)
    await advance(USER_SEARCH_DELAY_MS)
    expect(panel()).toBeInTheDocument()
  }

  it('Escape closes it, keeps the text and returns focus; the field reopens it as it was', async () => {
    const user = renderSearch()

    await openWithResults(user)
    await user.tab()
    await user.tab()
    expect(within(panel()).getByRole('link', { name: 'Олена Коваль' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(queryPanel()).not.toBeInTheDocument()
    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('Ол')

    await user.click(field())
    expect(within(panel()).getByText('Ольга Мельник')).toBeInTheDocument()
    expect(searches()).toHaveLength(1)
  })

  it('a click or Tab outside closes it', async () => {
    const user = renderSearch()

    await openWithResults(user)
    await user.click(screen.getByRole('button', { name: 'Поза пошуком' }))
    expect(queryPanel()).not.toBeInTheDocument()

    await user.click(field())
    // A press on the panel's own text is inside: it stays.
    await user.click(within(panel()).getAllByText('Ще не друзі')[0] ?? panel())
    expect(panel()).toBeInTheDocument()

    await user.click(field())
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Перед пошуком' })).toHaveFocus()
    expect(queryPanel()).not.toBeInTheDocument()
  })

  it('an answer arriving after it was closed does not open it on its own', async () => {
    const user = renderSearch()

    server.flags.holdSearches = true
    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    await user.keyboard('{Escape}')
    server.held[0]?.answer()
    await advance(0)
    expect(queryPanel()).not.toBeInTheDocument()

    await user.click(field())
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('names link to the person’s library, except across a block; the field controls the panel', async () => {
    const user = renderSearch()

    await openWithResults(user, 'на')

    expect(field()).toHaveAttribute('aria-controls', panel().id)
    expect(within(panel()).getByRole('link', { name: 'Олена Коваль' })).toHaveAttribute(
      'href',
      '/users/olena/library',
    )
    expect(within(panel()).getByText('Ірина Бондар')).toBeInTheDocument()
    expect(within(panel()).queryByRole('link', { name: 'Ірина Бондар' })).not.toBeInTheDocument()
  })
})

describe('UserSearch — actions on found people', () => {
  async function findRow(user: ReturnType<typeof setupUser>, name: string) {
    await user.type(field(), name)
    await advance(USER_SEARCH_DELAY_MS)

    const row = within(panel()).getByText(new RegExp(name)).closest('li')

    if (row === null) throw new Error(`No search result row for ${name}`)

    return row
  }

  it('sends a friend request, refreshes the relation once and the mounted friends lists', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Олена')
    const friendsLoads = requests('/friends').filter((path) => path === '/friends').length

    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await advance(0)

    expect(within(panel()).getByText('Запит надіслано — чекає на відповідь')).toBeInTheDocument()
    expect(requests('/friends/requests', 'POST')).toEqual(['/friends/requests'])
    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/requests',
      expect.objectContaining({ method: 'POST', body: { userId: 'olena' } }),
    )
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    expect(requests('/friends').filter((path) => path === '/friends').length).toBe(friendsLoads + 1)
  })

  it('accepts an incoming request found in the results', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Марко')

    // Its request id comes from the friend-request list the notifications share.
    await user.click(await within(row).findByRole('button', { name: 'Прийняти' }))
    await advance(0)

    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/requests/request-marko',
      expect.objectContaining({ method: 'PATCH', body: { action: 'accept' } }),
    )
    expect(within(panel()).getByText('Уже друзі')).toBeInTheDocument()
  })

  it('unblocks a person found in the results', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Ірина')

    await user.click(within(row).getByRole('button', { name: 'Розблокувати' }))
    await advance(0)

    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/ira',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(within(panel()).getByText('Ще не друзі')).toBeInTheDocument()
  })

  it('shows a failed action in the panel and forgets it once the text changes', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Олена')

    server.flags.failActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await advance(0)
    expect(within(panel()).getByRole('alert')).toHaveTextContent(NETWORK_ERROR)

    await user.type(field(), ' ')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('UserSearch — review regressions', () => {
  async function findRow(user: ReturnType<typeof setupUser>, name: string) {
    await user.type(field(), name)
    await advance(USER_SEARCH_DELAY_MS)

    const row = within(panel()).getByText(new RegExp(name)).closest('li')

    if (row === null) throw new Error(`No search result row for ${name}`)

    return row
  }

  const posts = () => requests('/friends/requests', 'POST')

  it('a slow friend request is sent once, whatever the text does meanwhile', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))

    // Only whitespace: the same query, the same row, still blocked.
    await user.type(field(), ' ')
    const sameRow = within(panel()).getByText('Олена Коваль').closest('li')

    expect(within(sameRow as HTMLElement).getByRole('button', { name: 'Надсилаю…' })).toBeDisabled()
    await user.click(within(sameRow as HTMLElement).getByRole('button', { name: 'Надсилаю…' }))

    // Another query that finds the same person: still the same pending action.
    await user.type(field(), 'К')
    await advance(USER_SEARCH_DELAY_MS)
    const otherQueryRow = within(panel()).getByText('Олена Коваль').closest('li') as HTMLElement

    expect(within(otherQueryRow).getByRole('button', { name: 'Надсилаю…' })).toBeDisabled()
    await user.click(within(otherQueryRow).getByRole('button', { name: 'Надсилаю…' }))
    expect(posts()).toHaveLength(1)

    // The block lasts until the request AND the refreshed relation are in.
    server.flags.holdSearches = true
    server.heldActions[0]?.answer()
    await advance(0)
    expect(within(panel()).queryByRole('button', { name: 'Додати' })).not.toBeInTheDocument()
    server.held.forEach((search) => search.answer())
    await advance(0)

    expect(within(panel()).getByText('Запит надіслано — чекає на відповідь')).toBeInTheDocument()
    expect(posts()).toHaveLength(1)
  })

  it('two quick clicks before the re-render send one request', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.dblClick(within(row).getByRole('button', { name: 'Додати' }))

    expect(posts()).toHaveLength(1)
  })

  it('a failed action of an earlier query is not shown as an error of the current one', async () => {
    const user = renderSearch()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await user.clear(field())
    await user.type(field(), 'Ольга')
    await advance(USER_SEARCH_DELAY_MS)

    server.heldActions[0]?.fail()
    await advance(0)

    expect(within(panel()).getByText('Ольга Мельник')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('«Прийняти» waits for the incoming request it answers', async () => {
    const user = renderSearch()

    await advance(0)
    server.flags.holdRequestList = true
    const row = await findRow(user, 'Марко')

    expect(within(row).getByRole('button', { name: 'Перевіряю…' })).toBeDisabled()

    server.heldRequestLists[0]?.answer()
    await advance(0)
    expect(within(row).getByRole('button', { name: 'Прийняти' })).toBeEnabled()
  })

  it('a failed request list says so; its retry reloads only the list, then «Прийняти» works', async () => {
    const user = renderSearch()

    // The friends probe has loaded its lists; the next list load — the search's — fails.
    await advance(0)
    server.failRequestList(1)
    const row = await findRow(user, 'Марко')
    // The list is asked for once a row needs it, and its failure takes a few more ticks.
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Не вдалося завантажити запит у друзі.',
    )
    const listLoads = requests('/friends/requests').length

    expect(within(row).queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Повторити' }))
    await advance(0)

    expect(requests('/friends/requests')).toHaveLength(listLoads + 1)
    expect(requests('/friends/requests/', 'PATCH')).toEqual([])
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Прийняти' }))
    await advance(0)

    expect(requests('/friends/requests/', 'PATCH')).toEqual(['/friends/requests/request-marko'])
    expect(within(panel()).getByText('Уже друзі')).toBeInTheDocument()
  })
})

describe('UserSearch — compact results and «Показати всі»', () => {
  const showAll = () => within(panel()).queryByRole('link', { name: 'Показати всі' })
  const pageOf = (query: string) => `/friends/search?${new URLSearchParams({ query }).toString()}`

  it(`shows at most ${String(HEADER_RESULTS_LIMIT)} people and links to all of them`, async () => {
    const user = renderSearch()

    await user.type(field(), '  Ол  ')
    await advance(USER_SEARCH_DELAY_MS)

    expect(within(panel()).getAllByRole('listitem')).toHaveLength(HEADER_RESULTS_LIMIT)
    // The normalized query, not the text as typed.
    expect(showAll()).toHaveAttribute('href', pageOf('Ол'))
  })

  it('following it closes the panel', async () => {
    const user = renderSearch()

    await user.type(field(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    const link = showAll()

    if (link === null) throw new Error('No «Показати всі»')
    // jsdom does not navigate; the panel reacts to the click itself.
    link.addEventListener('click', (event) => event.preventDefault())
    await user.click(link)

    expect(queryPanel()).not.toBeInTheDocument()
  })

  it('edited text never links to the previous query, and invalid text links nowhere', async () => {
    const user = renderSearch()

    await user.type(field(), 'Ол')
    await advance(USER_SEARCH_DELAY_MS)
    expect(showAll()).toHaveAttribute('href', pageOf('Ол'))

    await user.type(field(), 'е')
    expect(showAll()).not.toBeInTheDocument()
    await advance(USER_SEARCH_DELAY_MS)
    expect(showAll()).toHaveAttribute('href', pageOf('Оле'))

    await user.clear(field())
    await user.type(field(), 'О{Enter}')
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Мінімум два символи')
    expect(showAll()).not.toBeInTheDocument()
  })
})

describe('UserSearch — in the header', () => {
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

  it('is not offered to a guest, and nothing is searched', async () => {
    render(withQueryClient(<NavContent state={{ status: 'guest' }} />))
    await advance(1000)

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(searches()).toEqual([])
  })

  it('a signed-in person gets exactly one search field', () => {
    render(withQueryClient(<NavContent state={{ status: 'authenticated', user: me('anna') }} />))

    expect(screen.getAllByRole('search')).toHaveLength(1)
    expect(screen.getAllByRole('searchbox', { name: 'Ім’я або email' })).toHaveLength(1)
  })

  it('another account starts from an empty search and never sees the previous answers', async () => {
    const user = setupUser()
    // One cache for both accounts, as in one browser tab before `Providers` clears it.
    const client = createTestQueryClient()
    const cachedSearches = () =>
      client
        .getQueryCache()
        .findAll({ queryKey: ['users', 'search'] })
        .map((query) => query.queryKey)
    const { rerender } = render(
      withQueryClient(<NavContent state={{ status: 'authenticated', user: me('anna') }} />, client),
    )

    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    expect(within(panel()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(cachedSearches()).toEqual([['users', 'search', 'anna', 'Олена']])

    rerender(
      withQueryClient(
        <NavContent state={{ status: 'authenticated', user: me('bohdan') }} />,
        client,
      ),
    )
    expect(field()).toHaveValue('')
    expect(queryPanel()).not.toBeInTheDocument()

    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS)
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    // The same text is the other account's own cache entry, not the previous one's.
    expect(cachedSearches()).toContainEqual(['users', 'search', 'bohdan', 'Олена'])
  })
})
