/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import { withQueryClient } from '@/app/lib/test-query-client'
import { useFriends } from '@/app/lib/use-friends'
import { USER_SEARCH_DELAY_MS, USER_SEARCH_STALE_MS } from '../model/user-search'
import {
  NETWORK_ERROR,
  OLEKSAS,
  advance,
  advancePastPause,
  createHistory,
  createSearchTestClient,
  createServer,
  me,
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

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockHistory.replace, push: mockHistory.push }),
  useSearchParams: () => {
    const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react')
    const href = useSyncExternalStore(mockHistory.subscribe, mockHistory.current)

    return new URLSearchParams(href.split('?')[1] ?? '')
  },
}))

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: { status: 'authenticated', user: me('me') }, reload: jest.fn() }),
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

function renderPage() {
  const user = setupUser()

  mockHistory.open('/friends/search')
  render(
    withQueryClient(
      <>
        <UserSearchScreen />
        <FriendsProbe />
      </>,
      createSearchTestClient(),
    ),
  )

  return user
}

const field = () =>
  within(screen.getByRole('search', { name: 'Пошук людей' })).getByRole('searchbox', {
    name: 'Ім’я або email',
  })
const results = () => screen.getByRole('region', { name: 'Результати пошуку людей' })
const queryResults = () => screen.queryByRole('region', { name: 'Результати пошуку людей' })
const submitButton = () => screen.getByRole('button', { name: /^(Знайти|Шукаю…)$/ })

async function findRow(user: ReturnType<typeof setupUser>, name: string) {
  await user.type(field(), name)
  await advancePastPause()

  const row = within(results()).getByText(new RegExp(name)).closest('li')

  if (row === null) throw new Error(`No search result row for ${name}`)

  return row
}

beforeEach(() => {
  jest.useFakeTimers()
  apiRequest.mockReset()
  mockHistory.replace.mockClear()
  mockHistory.push.mockClear()
  server = createServer()
  apiRequest.mockImplementation(server.handle)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('/friends/search — searching while typing', () => {
  it('searches once with one query, the delay after the last keystroke', async () => {
    const user = renderPage()

    expect(field()).not.toHaveFocus()
    await user.type(field(), 'Олена')
    await advance(USER_SEARCH_DELAY_MS - 1)
    expect(searches()).toEqual([])

    await advance(1)
    expect(searches()).toEqual([searchFor('Олена')])
    // The answer is handed over 1 ms later (`advancePastPause`).
    await advance(1)
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
    expect(within(results()).queryByText('Ольга Мельник')).not.toBeInTheDocument()
  })

  it('sends a complete address as the same single query and shows the exact match', async () => {
    const user = renderPage()

    await user.type(field(), 'olena@example.com')
    await advancePastPause()

    expect(searches()).toEqual([searchFor('olena@example.com')])
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('sends nothing for blank or one-character text; only «Знайти» explains why', async () => {
    const user = renderPage()

    await user.type(field(), '   ')
    await user.keyboard('{Enter}')
    await advance(1000)
    expect(queryResults()).not.toBeInTheDocument()

    await user.clear(field())
    await user.type(field(), 'О')
    await advance(1000)
    expect(searches()).toEqual([])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(submitButton())
    expect(screen.getByRole('alert')).toHaveTextContent('Мінімум два символи')
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(searches()).toEqual([])
  })

  it('clearing the field drops the results, the pending search and the errors', async () => {
    const user = renderPage()

    await user.type(field(), 'Олена')
    await advancePastPause()
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()

    await user.clear(field())
    expect(queryResults()).not.toBeInTheDocument()

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
    const user = renderPage()

    await user.type(field(), 'Олена{Enter}')
    expect(searches()).toEqual([searchFor('Олена')])
    await advance(1000)
    expect(searches()).toEqual([searchFor('Олена')])

    await user.type(field(), ' Коваль')
    await user.click(submitButton())
    await advance(1000)
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена Коваль')])
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('Enter on the search already shown asks again, despite the fresh cache', async () => {
    const user = renderPage()

    await user.type(field(), 'Олена')
    await advancePastPause()
    await user.keyboard('{Enter}')
    await advance(0)

    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('returning to a text within the freshness window reuses its answer', async () => {
    const user = renderPage()

    await user.type(field(), 'Олена')
    await advancePastPause()
    await user.clear(field())
    await user.type(field(), 'Олена')
    await advancePastPause()

    expect(searches()).toEqual([searchFor('Олена')])
    expect(within(results()).getByText('Олена Коваль')).toBeInTheDocument()
  })

  it('an answer older than the freshness window is asked again', async () => {
    const user = renderPage()

    await user.type(field(), 'Ол')
    await advancePastPause()
    await user.clear(field())
    await advance(USER_SEARCH_STALE_MS)
    await user.type(field(), 'Ол')
    await advancePastPause()

    expect(searches()).toEqual([searchFor('Ол'), searchFor('Ол')])
    expect(within(results()).getAllByRole('listitem')).toHaveLength(2 + OLEKSAS.length)
  })

  it('keeps the field editable while searching and lets a new text run at once', async () => {
    const user = renderPage()

    server.flags.holdSearches = true
    await user.type(field(), 'Ол')
    await advancePastPause()
    expect(screen.getByRole('status')).toHaveTextContent('Шукаю людей…')
    expect(submitButton()).toBeDisabled()
    expect(field()).toBeEnabled()

    await user.type(field(), 'ена{Enter}')
    expect(field()).toHaveValue('Олена')
    expect(searches()).toEqual([searchFor('Ол'), searchFor('Олена')])
  })

  it('an answer arriving after the field was cleared is not shown', async () => {
    const user = renderPage()

    server.flags.holdSearches = true
    await user.type(field(), 'Олена')
    await advancePastPause()
    await user.clear(field())
    server.held[0]?.answer()
    await advance(0)

    expect(queryResults()).not.toBeInTheDocument()
    expect(screen.queryByText('Олена Коваль')).not.toBeInTheDocument()
  })

  it('names link to the person’s library, except across a block', async () => {
    const user = renderPage()

    await user.type(field(), 'на')
    await advancePastPause()

    expect(within(results()).getByRole('link', { name: 'Олена Коваль' })).toHaveAttribute(
      'href',
      '/u/olena-koval',
    )
    expect(within(results()).getByText('Ірина Бондар')).toBeInTheDocument()
    expect(within(results()).queryByRole('link', { name: 'Ірина Бондар' })).not.toBeInTheDocument()
  })
})

describe('/friends/search — actions on found people', () => {
  it('sends a friend request, refreshes the relation once and the mounted friends lists', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Олена')
    const friendsLoads = requests('/friends').filter((path) => path === '/friends').length

    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await advance(0)

    expect(within(results()).getByText('Запит надіслано — чекає на відповідь')).toBeInTheDocument()
    expect(requests('/friends/requests', 'POST')).toEqual(['/friends/requests'])
    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/requests',
      expect.objectContaining({ method: 'POST', body: { userId: 'olena' } }),
    )
    expect(searches()).toEqual([searchFor('Олена'), searchFor('Олена')])
    expect(requests('/friends').filter((path) => path === '/friends').length).toBe(friendsLoads + 1)
  })

  it('accepts an incoming request found in the results', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Марко')

    // Its request id comes from the friend-request list the notifications share.
    await user.click(await within(row).findByRole('button', { name: 'Прийняти' }))
    await advance(0)

    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/requests/request-marko',
      expect.objectContaining({ method: 'PATCH', body: { action: 'accept' } }),
    )
    expect(within(results()).getByText('Уже друзі')).toBeInTheDocument()
  })

  it('unblocks a person found in the results', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Ірина')

    await user.click(within(row).getByRole('button', { name: 'Розблокувати' }))
    await advance(0)

    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/ira',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(within(results()).getByText('Ще не друзі')).toBeInTheDocument()
  })

  it('shows a failed action and forgets it once the text changes', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Олена')

    server.flags.failActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await advance(0)
    expect(screen.getByRole('alert')).toHaveTextContent(NETWORK_ERROR)

    await user.type(field(), ' ')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('/friends/search — review regressions', () => {
  const posts = () => requests('/friends/requests', 'POST')

  it('a slow friend request is sent once, whatever the text does meanwhile', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))

    // Only whitespace: the same query, the same row, still blocked.
    await user.type(field(), ' ')
    const sameRow = within(results()).getByText('Олена Коваль').closest('li')

    expect(within(sameRow as HTMLElement).getByRole('button', { name: 'Надсилаю…' })).toBeDisabled()
    await user.click(within(sameRow as HTMLElement).getByRole('button', { name: 'Надсилаю…' }))

    // Another query that finds the same person: still the same pending action.
    await user.type(field(), 'К')
    await advancePastPause()
    const otherQueryRow = within(results()).getByText('Олена Коваль').closest('li') as HTMLElement

    expect(within(otherQueryRow).getByRole('button', { name: 'Надсилаю…' })).toBeDisabled()
    await user.click(within(otherQueryRow).getByRole('button', { name: 'Надсилаю…' }))
    expect(posts()).toHaveLength(1)

    // The block lasts until the request AND the refreshed relation are in.
    server.flags.holdSearches = true
    server.heldActions[0]?.answer()
    await advance(0)
    expect(screen.queryByRole('button', { name: 'Додати' })).not.toBeInTheDocument()
    server.held.forEach((search) => search.answer())
    await advance(0)

    expect(within(results()).getByText('Запит надіслано — чекає на відповідь')).toBeInTheDocument()
    expect(posts()).toHaveLength(1)
  })

  it('two quick clicks before the re-render send one request', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.dblClick(within(row).getByRole('button', { name: 'Додати' }))

    expect(posts()).toHaveLength(1)
  })

  it('a failed action of an earlier query is not shown as an error of the current one', async () => {
    const user = renderPage()
    const row = await findRow(user, 'Олена')

    server.flags.holdActions = true
    await user.click(within(row).getByRole('button', { name: 'Додати' }))
    await user.clear(field())
    await user.type(field(), 'Ольга')
    await advancePastPause()

    server.heldActions[0]?.fail()
    await advance(0)

    expect(within(results()).getByText('Ольга Мельник')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('«Прийняти» waits for the incoming request it answers', async () => {
    const user = renderPage()

    await advance(0)
    server.flags.holdRequestList = true
    const row = await findRow(user, 'Марко')

    expect(within(row).getByRole('button', { name: 'Перевіряю…' })).toBeDisabled()

    server.heldRequestLists[0]?.answer()
    await advance(0)
    expect(within(row).getByRole('button', { name: 'Прийняти' })).toBeEnabled()
  })

  it('a failed request list says so; its retry reloads only the list, then «Прийняти» works', async () => {
    const user = renderPage()

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
    expect(within(results()).getByText('Уже друзі')).toBeInTheDocument()
  })
})
