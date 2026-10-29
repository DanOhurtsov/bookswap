import { fetchReadingStatsSnapshot } from './fetch-reading-stats.server'

/**
 * BS-145: the server half of the home page's stats. Whose stats they are comes from the session, and
 * the private stats endpoint is never asked for a visitor who is not signed in.
 */
jest.mock('next/headers', () => ({ headers: jest.fn() }))

const { headers: mockHeaders } = jest.requireMock<{ headers: jest.Mock }>('next/headers')

const SESSION_COOKIE = 'bookswap_session=s3cr3t-token-value; theme=dark'
const SESSION_URL = 'http://localhost:3001/api/v1/auth/session'
const STATS_URL = 'http://localhost:3001/api/v1/me/reading-stats'

const ME = {
  user: {
    id: 'user-1',
    email: 'user-1@example.com',
    emailVerified: true,
    displayName: 'Користувач',
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
  },
  features: { guestLoans: false },
}
const STATS = { counts: { NOT_READ: 1, READING: 0, READ: 4 } }

type Answer = { status: number; body?: unknown } | Error

function withCookie(cookie: string | null): void {
  mockHeaders.mockResolvedValue({ get: (name: string) => (name === 'cookie' ? cookie : null) })
}

/** One answer per endpoint; an `Error` is a network failure. */
function serve(answers: { session?: Answer; stats?: Answer }): jest.Mock {
  const fetchMock = jest.fn((address: string) => {
    const answer = address === SESSION_URL ? answers.session : answers.stats

    if (answer === undefined) return Promise.reject(new Error(`unexpected ${address}`))
    if (answer instanceof Error) return Promise.reject(answer)

    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    })
  })

  global.fetch = fetchMock as unknown as typeof fetch

  return fetchMock
}

const urls = (fetchMock: jest.Mock): unknown[] => fetchMock.mock.calls.map(([address]) => address)

afterEach(() => {
  jest.restoreAllMocks()
})

describe('fetchReadingStatsSnapshot', () => {
  it('reads the session, then the stats, both with the incoming Cookie header whole and uncached', async () => {
    withCookie(SESSION_COOKIE)
    const fetchMock = serve({
      session: { status: 200, body: ME },
      stats: { status: 200, body: STATS },
    })

    await expect(fetchReadingStatsSnapshot()).resolves.toEqual({
      status: 'ready',
      userId: 'user-1',
      data: STATS,
    })
    expect(urls(fetchMock)).toEqual([SESSION_URL, STATS_URL])

    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init).toEqual({ cache: 'no-store', headers: { cookie: SESSION_COOKIE } })
    }
  })

  it.each([null, ''])(
    'a visitor without a cookie (%p) is a guest, and nothing is asked',
    async (cookie) => {
      withCookie(cookie)
      const fetchMock = serve({})

      await expect(fetchReadingStatsSnapshot()).resolves.toEqual({ status: 'guest' })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('a cookie that is no session is a guest, and the private stats endpoint is never asked', async () => {
    withCookie('theme=dark')
    const fetchMock = serve({
      session: { status: 401, body: { code: 'UNAUTHORIZED', message: 'x' } },
    })

    await expect(fetchReadingStatsSnapshot()).resolves.toEqual({ status: 'guest' })
    expect(urls(fetchMock)).toEqual([SESSION_URL])
  })

  it('a session that ended between the two reads is a guest', async () => {
    withCookie(SESSION_COOKIE)
    serve({ session: { status: 200, body: ME }, stats: { status: 401, body: {} } })

    await expect(fetchReadingStatsSnapshot()).resolves.toEqual({ status: 'guest' })
  })

  it.each<[string, { session?: Answer; stats?: Answer }]>([
    ['the session read fails', { session: { status: 503, body: {} } }],
    ['the session answer breaks the contract', { session: { status: 200, body: { user: {} } } }],
    [
      'the stats read fails',
      { session: { status: 200, body: ME }, stats: { status: 500, body: {} } },
    ],
    [
      'the stats answer breaks the contract',
      {
        session: { status: 200, body: ME },
        stats: { status: 200, body: { counts: { READ: -1 } } },
      },
    ],
    ['the API is unreachable', { session: new TypeError('fetch failed') }],
  ])('%s: an error, never zeros', async (_case, answers) => {
    withCookie(SESSION_COOKIE)
    serve(answers)

    await expect(fetchReadingStatsSnapshot()).resolves.toEqual({ status: 'error' })
  })

  it('never logs, and never returns, the cookie', async () => {
    withCookie(SESSION_COOKIE)
    serve({ session: new TypeError(`fetch failed with ${SESSION_COOKIE}`) })
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ]

    const result = await fetchReadingStatsSnapshot()

    expect(JSON.stringify(result)).not.toContain('s3cr3t')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
