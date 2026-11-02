/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FriendsNewBooksResponse, Me } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { Providers } from '@/app/lib/query-client'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { installCarouselEnvironment } from './carousel-test-env'
import { FriendsNewBooks } from './FriendsNewBooks'

/**
 * BS-147: another account in the same tab. The REAL `SessionProvider` and `Providers` (which clears the
 * query cache when the identity changes). Only `apiRequest` is replaced, by a tiny server whose answer
 * depends on who is signed in when the request is sent — and which can hold an answer back.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const SECTION = 'Нове в бібліотеках друзів'
const EMPTY = 'Друзі ще нічого не додали'

installCarouselEnvironment()

let signedIn: string | null
let held: (() => void)[]
let holdFeed: boolean

function me(id: string): Me {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    displayName: id,
    handle: 'reader',
    city: null,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: true,
    friendsOfFriendsAccess: false,
    loanRequestsPaused: false,
    defaultLoanTermDays: null,
    ownerDueReminders: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

const FEEDS: Record<string, FriendsNewBooksResponse> = {
  'user-a': {
    hasFriends: true,
    items: [
      {
        friend: {
          id: 'friend-of-a',
          displayName: 'Друг А',
          handle: 'friend-of-a',
          avatarUrl: null,
        },
        work: { id: 'w-a', title: 'Книжка, яку додав друг А' },
        authors: [],
        coverUrl: null,
        addedAt: '2026-10-20T10:00:00.000Z',
      },
    ],
  },
  'user-b': { hasFriends: false, items: [] },
}

function serve(): void {
  apiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') {
      return signedIn === null
        ? Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
        : Promise.resolve({ user: me(signedIn) })
    }

    if (path !== '/me/friends/new-books' || signedIn === null)
      return Promise.reject(new Error(`unexpected ${path}`))

    // The answer belongs to whoever was signed in when the request was SENT, even if it lands later.
    const answer = FEEDS[signedIn]

    if (!holdFeed) return Promise.resolve(answer)

    holdFeed = false

    return new Promise((resolve) => {
      held.push(() => {
        resolve(answer)
      })
    })
  })
}

function SessionControls() {
  const { state, setGuest, setUser } = useSession()

  return (
    <div>
      <p data-testid="who">{state.status === 'authenticated' ? state.user.id : state.status}</p>
      <button type="button" onClick={setGuest}>
        logout
      </button>
      <button
        type="button"
        onClick={() => {
          signedIn = 'user-b'
          setUser(me('user-b'))
        }}
      >
        login-b
      </button>
    </div>
  )
}

function renderApp() {
  return render(
    <SessionProvider>
      <Providers>
        <SessionControls />
        <FriendsNewBooks />
      </Providers>
    </SessionProvider>,
  )
}

/** Every committed DOM state, so «not even one frame» can be checked after the fact. */
function recordFrames(container: HTMLElement): string[] {
  const frames: string[] = []
  const observer = new MutationObserver(() => {
    frames.push(container.textContent ?? '')
  })

  observer.observe(container, { subtree: true, childList: true, characterData: true })

  return frames
}

beforeEach(() => {
  apiRequest.mockReset()
  signedIn = 'user-a'
  held = []
  holdFeed = false
  serve()
})

describe('FriendsNewBooks across an account change (BS-147)', () => {
  it('A → logout → B: B never sees, even for a frame, what A’s friends have added', async () => {
    const user = userEvent.setup()
    const { container } = renderApp()

    expect(
      await screen.findByRole('link', { name: /^Книжка, яку додав друг А\./ }),
    ).toBeInTheDocument()

    const frames = recordFrames(container)

    signedIn = null
    await user.click(screen.getByRole('button', { name: 'logout' }))

    expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'login-b' }))

    const section = await screen.findByRole('region', { name: SECTION })

    expect(await within(section).findByText(EMPTY)).toBeInTheDocument()
    expect(frames.filter((frame) => frame.includes('user-b'))).not.toHaveLength(0)
    expect(frames.some((frame) => frame.includes('user-b') && frame.includes('друг А'))).toBe(false)
  })

  it('A’s answer that lands after the switch to B is never shown to B', async () => {
    const user = userEvent.setup()

    holdFeed = true
    renderApp()

    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    await user.click(screen.getByRole('button', { name: 'login-b' }))

    const section = await screen.findByRole('region', { name: SECTION })

    expect(await within(section).findByText(EMPTY)).toBeInTheDocument()

    held[0]!()

    await waitFor(() => {
      expect(screen.getByTestId('who')).toHaveTextContent('user-b')
    })
    expect(screen.queryByText('Книжка, яку додав друг А')).not.toBeInTheDocument()
    expect(within(section).getByText(EMPTY)).toBeInTheDocument()
  })
})
