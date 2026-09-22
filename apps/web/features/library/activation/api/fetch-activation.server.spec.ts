import type { ActivationResponse } from '@bookswap/shared'
import { fetchActivationProgress } from './fetch-activation.server'

/**
 * Stage 8h-2: the server half of the activation read.
 *
 * The session cookie is the whole reason this module exists on the server, so
 * most of what is checked here is about that cookie: that it is forwarded
 * verbatim, that no request goes out without one, and that it never comes back
 * out — neither in the returned state nor in anything written to the console.
 */
jest.mock('next/headers', () => ({ headers: jest.fn() }))

const { headers: mockHeaders } = jest.requireMock<{ headers: jest.Mock }>('next/headers')

const SESSION_COOKIE = 'bookswap_session=s3cr3t-token-value; theme=dark'
const ENDPOINT = 'http://localhost:3001/api/v1/me/activation'

const VALID: ActivationResponse = {
  ownedCopyCount: 3,
  target: 10,
  hasReachedTarget: false,
  nextAction: 'ADD_BOOKS',
}

function withCookie(cookie: string | null): void {
  mockHeaders.mockResolvedValue({ get: (name: string) => (name === 'cookie' ? cookie : null) })
}

function respondWith(body: unknown, status = 200): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })

  global.fetch = fetchMock as unknown as typeof fetch

  return fetchMock
}

/** Every console channel, so "does not log the cookie" is not just about `log`. */
function silenceConsole(): jest.SpyInstance[] {
  return [
    jest.spyOn(console, 'log').mockImplementation(() => undefined),
    jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    jest.spyOn(console, 'error').mockImplementation(() => undefined),
  ]
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('fetchActivationProgress', () => {
  it('asks the activation endpoint and forwards the incoming Cookie header whole', async () => {
    withCookie(SESSION_COOKIE)
    const fetchMock = respondWith(VALID)

    await fetchActivationProgress()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, {
      cache: 'no-store',
      headers: { cookie: SESSION_COOKIE },
    })
  })

  it('never caches: the count changes with every book added or deleted', async () => {
    withCookie(SESSION_COOKIE)
    const fetchMock = respondWith(VALID)

    await fetchActivationProgress()

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('returns the parsed progress on success', async () => {
    withCookie(SESSION_COOKIE)
    respondWith(VALID)

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'ready', data: VALID })
  })

  it('is a guest with no cookie at all, and spends no request finding out', async () => {
    withCookie(null)
    const fetchMock = respondWith(VALID)

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'guest' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is a guest on 401', async () => {
    withCookie(SESSION_COOKIE)
    respondWith({ code: 'UNAUTHORIZED', message: 'ні' }, 401)

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'guest' })
  })

  it.each([403, 429, 500, 503])('is an error on %i', async (status) => {
    withCookie(SESSION_COOKIE)
    respondWith({ code: 'INTERNAL', message: 'ой' }, status)

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'error' })
  })

  it('is an error when the API answers something the contract does not allow', async () => {
    withCookie(SESSION_COOKIE)
    // Nine books and «invite friends» — each field plausible, the response not.
    respondWith({ ...VALID, ownedCopyCount: 9, nextAction: 'INVITE_FRIENDS' })

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'error' })
  })

  it('is an error when the API cannot be reached, without throwing at the page', async () => {
    withCookie(SESSION_COOKIE)
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error(`connect ECONNREFUSED — cookie ${SESSION_COOKIE}`))

    await expect(fetchActivationProgress()).resolves.toEqual({ status: 'error' })
  })

  it('never lets the cookie back out — not in the result, not into any log', async () => {
    const spies = silenceConsole()
    withCookie(SESSION_COOKIE)
    // The failure path is the dangerous one: a fetch error can carry the whole
    // request, cookie included, and passing it on would publish a credential.
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error(`request failed: cookie ${SESSION_COOKIE}`))

    const result = await fetchActivationProgress()

    expect(JSON.stringify(result)).not.toContain('s3cr3t-token-value')
    expect(JSON.stringify(result)).not.toContain('bookswap_session')

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
