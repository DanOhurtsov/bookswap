import type { QueryClient } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FriendRelation, Me, PublicUser } from '@bookswap/shared'
import { createTestQueryClient } from '@/app/lib/test-query-client'
import { USER_SEARCH_QUERY_KEY } from './model/use-user-search'
import { USER_SEARCH_DELAY_MS } from './model/user-search'

export const OLENA: PublicUser = {
  id: 'olena',
  displayName: 'Олена Коваль',
  handle: 'olena-koval',
  avatarUrl: null,
}
export const OLHA: PublicUser = {
  id: 'olha',
  displayName: 'Ольга Мельник',
  handle: 'olha',
  avatarUrl: null,
}
export const MARKO: PublicUser = {
  id: 'marko',
  displayName: 'Марко Левченко',
  handle: 'marko',
  avatarUrl: null,
}
export const IRA: PublicUser = {
  id: 'ira',
  displayName: 'Ірина Бондар',
  handle: 'ira',
  avatarUrl: null,
}
/** Five more «Ол…» people: «Ол» finds seven. */
export const OLEKSAS: PublicUser[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `oleksa-${String(n)}`,
  displayName: `Олекса ${String(n)}`,
  handle: `oleksa-${String(n)}`,
  avatarUrl: null,
}))
/** A name full of characters an address must keep: `+`, `&`, `@`, spaces, Cyrillic. */
export const TRICKY: PublicUser = {
  id: 'tricky',
  displayName: 'Ян & Co + @друзі',
  handle: 'tricky',
  avatarUrl: null,
}

const PEOPLE = [OLENA, OLHA, MARKO, IRA, ...OLEKSAS, TRICKY]
const EMAILS: Record<string, PublicUser> = { 'olena@example.com': OLENA }

export const NETWORK_ERROR = /Не вдалося звʼязатися з API/

/** The signed-in person `id`, as the session reports them. */
export const me = (id: string): Me => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  displayName: id,
  handle: 'reader',
  city: null,
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: false,
  friendsOfFriendsAccess: false,
  loanRequestsPaused: false,
  defaultLoanTermDays: null,
  ownerDueReminders: true,
  createdAt: '2026-01-01T00:00:00.000Z',
})

/** The browser history the page sees: entries, a cursor, and who listens for changes. */
export function createHistory() {
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

/** `/friends/search?query=…`, encoded as the page writes it. */
export const pageOf = (query: string) =>
  `/friends/search?${new URLSearchParams({ query }).toString()}`

interface Held {
  path: string
  answer: () => void
  fail: () => void
}

type ApiOptions = { method?: string; body?: unknown }

/**
 * The API behind the search: the union of a partial name match and an exact address match,
 * relations that change with the friend actions, and searches or actions that can be held to
 * answer them out of order.
 */
export function createServer() {
  const relations: Record<string, FriendRelation> = Object.fromEntries(
    PEOPLE.map((person) => [person.id, 'NONE' as FriendRelation]),
  )
  relations.marko = 'REQUEST_RECEIVED'
  relations.ira = 'BLOCKED_BY_ME'

  const held: Held[] = []
  const heldActions: Held[] = []
  const heldRequestLists: Held[] = []
  const flags = {
    holdSearches: false,
    failSearches: false,
    holdActions: false,
    failActions: false,
    holdRequestList: false,
  }
  let requestListFailures = 0

  function results(path: string) {
    const query = (new URL(path, 'http://api.test').searchParams.get('query') ?? '').trim()
    const exact = EMAILS[query.toLowerCase()]
    const byName = PEOPLE.filter(
      (user) => user !== exact && user.displayName.toLowerCase().includes(query.toLowerCase()),
    )
    const users = exact === undefined ? byName : [exact, ...byName]

    return { results: users.map((user) => ({ user, relation: relations[user.id] })) }
  }

  function deferred(list: Held[], path: string, answer: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      list.push({
        path,
        answer: () => resolve(answer()),
        fail: () => reject(new TypeError('Failed to fetch')),
      })
    })
  }

  function search(path: string): Promise<unknown> {
    if (flags.failSearches) return Promise.reject(new TypeError('Failed to fetch'))
    if (!flags.holdSearches) return Promise.resolve(results(path))

    return deferred(held, path, () => results(path))
  }

  function change(path: string, method: string, body: unknown): (() => unknown) | undefined {
    if (path === '/friends/requests' && method === 'POST') {
      const { userId } = body as { userId: string }

      return () => {
        relations[userId] = 'REQUEST_SENT'
        return { state: 'REQUEST_SENT' }
      }
    }
    if (path === '/friends/requests/request-marko' && method === 'PATCH') {
      return () => {
        relations.marko = 'FRIENDS'
        return { state: 'FRIENDS' }
      }
    }
    if (path === '/friends/ira' && method === 'DELETE') {
      return () => {
        relations.ira = 'NONE'
        return undefined
      }
    }

    return undefined
  }

  function handle(path: string, options: ApiOptions = {}): Promise<unknown> {
    const method = options.method ?? 'GET'

    if (path.startsWith('/users?')) return search(path)
    if (path === '/friends' && method === 'GET') return Promise.resolve({ friends: [] })
    if (path === '/friends/requests' && method === 'GET') {
      if (requestListFailures > 0) {
        requestListFailures -= 1
        return Promise.reject(new TypeError('Failed to fetch'))
      }

      const list = () => ({
        incoming:
          relations.marko === 'REQUEST_RECEIVED'
            ? [{ id: 'request-marko', user: MARKO, createdAt: '2026-08-24T10:00:00Z' }]
            : [],
        outgoing: [],
      })

      return flags.holdRequestList
        ? deferred(heldRequestLists, path, list)
        : Promise.resolve(list())
    }

    const apply = change(path, method, options.body)

    if (apply === undefined) return Promise.reject(new Error(`Unexpected: ${method} ${path}`))
    if (flags.failActions) return Promise.reject(new TypeError('Failed to fetch'))
    if (flags.holdActions) return deferred(heldActions, path, apply)

    return Promise.resolve(apply())
  }

  return {
    handle,
    held,
    heldActions,
    heldRequestLists,
    flags,
    /** The next `count` loads of `GET /friends/requests` fail. */
    failRequestList: (count: number) => {
      requestListFailures = count
    },
  }
}

export type FakeServer = ReturnType<typeof createServer>

/** Requests the mocked `apiRequest` received, by path prefix and method. */
export function requestsOf(apiRequest: jest.Mock, prefix: string, method = 'GET'): string[] {
  return apiRequest.mock.calls
    .filter(([path, options]: [unknown, ApiOptions | undefined]) => {
      return String(path).startsWith(prefix) && (options?.method ?? 'GET') === method
    })
    .map(([path]: [unknown]) => String(path))
}

export const searchFor = (text: string) => `/users?query=${encodeURIComponent(text)}`

/** Moves the clock by `ms`, then delivers what became due without moving it further. */
export async function advance(ms: number): Promise<void> {
  await act(() => jest.advanceTimersByTimeAsync(ms))
  // A due search starts on the render the first step causes, and TanStack Query hands its
  // answer to the screen on a zero-delay timer: separate steps, the clock stays where it is.
  await act(() => jest.advanceTimersByTimeAsync(0))
  await act(() => jest.advanceTimersByTimeAsync(0))
}

/**
 * Lets the pause run out on the search page and its answer arrive. The launch writes the address,
 * and the page re-renders from it while the fake clock is still ticking: the request and TanStack
 * Query's zero-delay hand-over of its answer are set up inside that tick, where
 * @sinonjs/fake-timers makes a zero delay due 1 ms later.
 */
export async function advancePastPause(): Promise<void> {
  await advance(USER_SEARCH_DELAY_MS)
  await advance(1)
}

export function setupUser() {
  return userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
}

/** TanStack's default `gcTime` — what the app's `Providers` leaves searches with. */
const APP_GC_TIME_MS = 5 * 60_000

/**
 * The test client (`gcTime: 0` for everything else), except that searches stay cached as in the
 * app: reusing a fresh answer is part of what these specs check.
 */
export function createSearchTestClient(): QueryClient {
  const client = createTestQueryClient()

  client.setQueryDefaults(USER_SEARCH_QUERY_KEY, { gcTime: APP_GC_TIME_MS })

  return client
}
