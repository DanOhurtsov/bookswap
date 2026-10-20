/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, type ComponentType } from 'react'
import type { Me, ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { Providers } from '@/app/lib/query-client'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { chooseOption } from '@/components/Form/test-choose-option'
import { readingStatusQueryKey } from '../model/use-reading-status'
import { ReadingStatusPanel } from './ReadingStatusPanel'
import { ShelfReadingStatus } from './ShelfReadingStatus'

/**
 * BS-140: another account in the same tab, with a status control already on screen. The REAL
 * `SessionProvider` and `Providers` (which clears the query cache when the identity changes) — an
 * isolated `QueryClientProvider` would not have that clear at all. Only `apiRequest` is replaced, by
 * a tiny server whose answer depends on who is signed in when the request is sent.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const STATUS_PATH = '/me/reading-statuses/w-1'

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

/** Who the server's session cookie names; `null` — nobody. */
let signedIn: string | null
let rows: Map<string, ReadingStatus>
/** Requests held back by the test, in the order they were sent. */
let held: { path: string; method: string; release: () => void }[]
let holdNext: boolean

function me(id: string): Me {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    displayName: id,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === '/auth/session') {
      return signedIn === null
        ? Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
        : Promise.resolve({ user: me(signedIn) })
    }

    if (path !== STATUS_PATH || signedIn === null)
      return Promise.reject(new Error(`unexpected ${path}`))

    // The answer belongs to whoever was signed in when the request was SENT, even if it lands later.
    const user = signedIn
    const method = options.method ?? 'GET'
    let respond: () => unknown

    if (method === 'PUT' && options.body !== undefined) {
      const { status } = options.body

      respond = () => {
        rows.set(user, status)

        return { workId: 'w-1', status }
      }
    } else {
      const status = rows.get(user)
      const snapshot = {
        workId: 'w-1',
        status: status ?? 'NOT_READ',
        isSet: status !== undefined,
        wasBorrowed: false,
      }

      respond = () => snapshot
    }

    if (!holdNext) return Promise.resolve(respond())

    holdNext = false

    return new Promise((resolve) => {
      held.push({ path, method, release: () => resolve(respond()) })
    })
  })
}

let client: QueryClient | undefined

/** Exposes the tab's one `QueryClient` and the session actions the app itself uses. */
function SessionControls() {
  const { state, reload, setGuest, setUser } = useSession()
  const queryClient = useQueryClient()

  useEffect(() => {
    client = queryClient
  }, [queryClient])

  return (
    <div>
      <p data-testid="who">{state.status === 'authenticated' ? state.user.id : state.status}</p>
      <button type="button" onClick={reload}>
        reload
      </button>
      <button type="button" onClick={setGuest}>
        logout
      </button>
      <button
        type="button"
        onClick={() => {
          setUser(me('user-b'))
        }}
      >
        login-b
      </button>
    </div>
  )
}

const CONTROLS: [string, ComponentType, string][] = [
  ['ReadingStatusPanel', () => <ReadingStatusPanel workId="w-1" />, 'Мій статус читання'],
  [
    'ShelfReadingStatus',
    () => <ShelfReadingStatus workId="w-1" title="Кобзар" />,
    'Мій статус читання: «Кобзар»',
  ],
]

/** Every committed DOM state, so «not even one frame» can be checked after the fact. */
function recordFrames(container: HTMLElement): { who: string; status: string }[] {
  const frames: { who: string; status: string }[] = []
  const observer = new MutationObserver(() => {
    frames.push({
      who: container.querySelector('[data-testid="who"]')?.textContent ?? '',
      status: container.querySelector('[role="combobox"]')?.textContent ?? '',
    })
  })

  observer.observe(container, { subtree: true, childList: true, characterData: true })

  return frames
}

function renderApp(Control: ComponentType) {
  return render(
    <SessionProvider>
      <Providers>
        <SessionControls />
        <Control />
      </Providers>
    </SessionProvider>,
  )
}

async function expectStatus(field: string, text: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: field })).toHaveTextContent(text)
  })
}

beforeEach(() => {
  apiRequest.mockReset()
  signedIn = 'user-a'
  rows = new Map([
    ['user-a', 'READING'],
    ['user-b', 'READ'],
  ])
  held = []
  holdNext = false
  client = undefined
  serve()
})

describe.each(CONTROLS)('%s across an account change (BS-140)', (_name, Control, field) => {
  it('A → B through session.reload(): the mounted control loads B’s status, never showing A’s', async () => {
    const user = userEvent.setup()
    const { container } = renderApp(Control)

    await expectStatus(field, 'Читаю')

    const frames = recordFrames(container)

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))

    await expectStatus(field, 'Прочитано')
    expect(screen.getByTestId('who')).toHaveTextContent('user-b')
    expect(
      frames.filter((frame) => frame.who === 'user-b' && frame.status.includes('Читаю')),
    ).toEqual([])
  })

  it('logout, then another account signs in: its status loads without a reload', async () => {
    const user = userEvent.setup()

    renderApp(Control)
    await expectStatus(field, 'Читаю')

    signedIn = null
    await user.click(screen.getByRole('button', { name: 'logout' }))
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: field })).not.toBeInTheDocument()
    })

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'login-b' }))

    await expectStatus(field, 'Прочитано')
  })

  it('A’s read that lands after the switch neither shows for B nor comes back into the cache', async () => {
    const user = userEvent.setup()

    renderApp(Control)
    await expectStatus(field, 'Читаю')

    // A asks again (the retry of a failed refresh would do the same) and the answer is held back.
    holdNext = true
    act(() => {
      void client?.invalidateQueries({ queryKey: ['reading-status', 'user-a'] })
    })
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))
    await expectStatus(field, 'Прочитано')

    await act(async () => {
      held[0]?.release()
      await Promise.resolve()
    })

    await expectStatus(field, 'Прочитано')
    expect(client?.getQueryData(readingStatusQueryKey('user-a', 'w-1'))).toBeUndefined()
  })

  it('A’s save that lands after the switch is not B’s: B’s status and save state stay B’s', async () => {
    const user = userEvent.setup()

    renderApp(Control)
    await expectStatus(field, 'Читаю')

    holdNext = true
    await chooseOption(user, field, 'Не читав')
    await waitFor(() => {
      expect(held).toEqual([expect.objectContaining({ method: 'PUT' })])
    })

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))
    await expectStatus(field, 'Прочитано')

    await act(async () => {
      held[0]?.release()
      await Promise.resolve()
    })

    await expectStatus(field, 'Прочитано')
    expect(screen.getByRole('combobox', { name: field })).toBeEnabled()
    expect(screen.queryByText(/Збережено/)).not.toBeInTheDocument()
    expect(screen.queryByText('Зберігаю…')).not.toBeInTheDocument()
    expect(client?.getQueryData(readingStatusQueryKey('user-a', 'w-1'))).toBeUndefined()
    // A's save did reach A's row on the server; it simply is not B's.
    expect(rows.get('user-a')).toBe('NOT_READ')
  })
})
