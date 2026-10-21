/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ComponentType } from 'react'
import type { Me, ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { Providers } from '@/app/lib/query-client'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { chooseOption } from '@/components/Form/test-choose-option'
import type { ReadingStatsSnapshot } from '../model/reading-stats-view'
import { readingStatsQueryKey } from '../model/use-reading-stats'
import { HomeReadingStats } from './HomeReadingStats'
import { ReadingStatusPanel } from './ReadingStatusPanel'
import { ShelfReadingStatus } from './ShelfReadingStatus'

/**
 * BS-145: the home page's counts follow every confirmed status save, mounted or not, and never show
 * another account's numbers. The REAL `SessionProvider` and `Providers` (which clears the cache when
 * the identity changes); only `apiRequest` is replaced, by a tiny server whose answers depend on who
 * is signed in when a request is sent — and are computed then, like a database read.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const STATS_PATH = '/me/reading-stats'
const STATUS_PATH = '/me/reading-statuses/w-1'
const SECTION = 'Моє читання'

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

/** Who the session cookie names; `null` — nobody. */
let signedIn: string | null
/** Per user: work → status. A work without an entry has no status set. */
let rows: Map<string, Map<string, ReadingStatus>>
/** Requests held back by the test, in the order they were sent. */
let held: { path: string; method: string; release: () => void }[]
/** Paths whose next request is held back. */
let holdNext: Set<string>
/** Paths whose next request fails. */
let failNext: Set<string>

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

function statusesOf(user: string): Map<string, ReadingStatus> {
  const own = rows.get(user) ?? new Map<string, ReadingStatus>()

  rows.set(user, own)

  return own
}

function answer(user: string, path: string, options: RequestOptions): () => unknown {
  const own = statusesOf(user)

  if (path === STATS_PATH) {
    const counts = { NOT_READ: 0, READING: 0, READ: 0 }

    for (const status of own.values()) counts[status] += 1

    return () => ({ counts })
  }

  if (options.method === 'PUT' && options.body !== undefined) {
    const { status } = options.body

    return () => {
      own.set('w-1', status)

      return { workId: 'w-1', status }
    }
  }

  const status = own.get('w-1')
  const snapshot = {
    workId: 'w-1',
    status: status ?? 'NOT_READ',
    isSet: status !== undefined,
    wasBorrowed: false,
  }

  return () => snapshot
}

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === '/auth/session') {
      return signedIn === null
        ? Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
        : Promise.resolve({ user: me(signedIn) })
    }

    if ((path !== STATS_PATH && path !== STATUS_PATH) || signedIn === null)
      return Promise.reject(new Error(`unexpected ${path}`))

    if (failNext.delete(path)) {
      return Promise.reject(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Збій' }))
    }

    // The answer belongs to whoever was signed in when the request was SENT, even if it lands later.
    const respond = answer(signedIn, path, options)

    if (!holdNext.delete(path)) return Promise.resolve(respond())

    return new Promise((resolve) => {
      held.push({ path, method: options.method ?? 'GET', release: () => resolve(respond()) })
    })
  })
}

let client: QueryClient | undefined

interface HarnessProps {
  initial: ReadingStatsSnapshot
  Control: ComponentType
  /** The tab starts on another page: home has never been mounted. */
  isAway: boolean
}

/** The tab's one `QueryClient`, the session actions the app itself uses, and a way to leave home. */
function Harness({ initial, Control, isAway }: HarnessProps) {
  const { state, reload, setGuest, setUser } = useSession()
  const queryClient = useQueryClient()
  const [isHome, setIsHome] = useState(!isAway)

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
      <button
        type="button"
        onClick={() => {
          setIsHome((value) => !value)
        }}
      >
        {isHome ? 'leave-home' : 'back-home'}
      </button>
      {isHome && <HomeReadingStats initial={initial} />}
      {state.status === 'authenticated' && <Control />}
    </div>
  )
}

const PANEL = 'Мій статус читання'
const SHELF = 'Мій статус читання: «Кобзар»'

const CONTROLS: [string, ComponentType, string][] = [
  ['ReadingStatusPanel', () => <ReadingStatusPanel workId="w-1" />, PANEL],
  ['ShelfReadingStatus', () => <ShelfReadingStatus workId="w-1" title="Кобзар" />, SHELF],
]

function renderApp({
  initial = { status: 'error' },
  Control = CONTROLS[0]![1],
  container,
  isAway = false,
}: {
  initial?: ReadingStatsSnapshot
  Control?: ComponentType
  container?: HTMLElement
  isAway?: boolean
} = {}) {
  return render(
    <SessionProvider>
      <Providers>
        <Harness initial={initial} Control={Control} isAway={isAway} />
      </Providers>
    </SessionProvider>,
    container === undefined ? {} : { container },
  )
}

function section(): HTMLElement {
  return screen.getByRole('region', { name: SECTION })
}

async function expectCounts(NOT_READ: number, READING: number, READ: number): Promise<void> {
  await waitFor(() => {
    const shown = ['Не читав', 'Читаю', 'Прочитано'].map(
      (label) =>
        within(section()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent,
    )

    expect(shown).toEqual([NOT_READ, READING, READ].map(String))
  })
}

async function expectStatus(field: string, text: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: field })).toHaveTextContent(text)
  })
}

function requests(path: string, method = 'GET'): unknown[] {
  return apiRequest.mock.calls.filter(
    ([sent, options]) =>
      sent === path && ((options as RequestOptions | undefined)?.method ?? 'GET') === method,
  )
}

/** Every committed text of the stats block, so «not even one frame» can be checked after the fact. */
function recordStats(container: HTMLElement): string[] {
  const frames: string[] = []
  const observer = new MutationObserver(() => {
    frames.push(container.querySelector('.reading-stats')?.textContent ?? '')
  })

  observer.observe(container, { subtree: true, childList: true, characterData: true })

  return frames
}

beforeEach(() => {
  apiRequest.mockReset()
  signedIn = 'user-a'
  rows = new Map([
    [
      'user-a',
      new Map<string, ReadingStatus>([
        ['w-1', 'READING'],
        ['w-2', 'READ'],
      ]),
    ],
    ['user-b', new Map<string, ReadingStatus>([['w-9', 'NOT_READ']])],
  ])
  held = []
  holdNext = new Set()
  failNext = new Set()
  client = undefined
  serve()
})

describe.each(CONTROLS)('a confirmed save from %s', (_name, Control, field) => {
  it('updates the mounted home counts without a reload, by one more stats read', async () => {
    const user = userEvent.setup()

    renderApp({ Control })
    await expectCounts(0, 1, 1)
    await expectStatus(field, 'Читаю')

    await chooseOption(user, field, 'Прочитано')

    await expectCounts(0, 0, 2)
    expect(requests(STATS_PATH)).toHaveLength(2)
    expect(requests(STATUS_PATH, 'PUT')).toHaveLength(1)
  })
})

describe('home counts after a status save (BS-145)', () => {
  it('the first explicit «Не читав» counts', async () => {
    const user = userEvent.setup()

    rows.set('user-a', new Map())
    renderApp()

    expect(await screen.findByText(/Ви ще не позначили жодного твору/)).toBeInTheDocument()
    await expectStatus(PANEL, 'Вказати статус читання')

    await chooseOption(user, PANEL, 'Не читав')

    await expectCounts(1, 0, 0)
  })

  it('choosing the same status again sends nothing and changes no count', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')

    await chooseOption(user, PANEL, 'Читаю')

    await expectCounts(0, 1, 1)
    expect(requests(STATUS_PATH, 'PUT')).toEqual([])
    expect(requests(STATS_PATH)).toHaveLength(1)
  })

  it('a failed save leaves the status and the counts as they were, and re-reads nothing', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')

    failNext.add(STATUS_PATH)
    await chooseOption(user, PANEL, 'Прочитано')

    expect(await screen.findByRole('button', { name: 'Спробувати ще раз' })).toBeInTheDocument()
    await expectStatus(PANEL, 'Читаю')
    await expectCounts(0, 1, 1)
    expect(requests(STATS_PATH)).toHaveLength(1)
  })

  it('a failed re-read of the counts does not fail the save: it is an error with its own retry', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')

    failNext.add(STATS_PATH)
    await chooseOption(user, PANEL, 'Прочитано')

    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()

    const alert = await within(section()).findByRole('alert')

    expect(alert).toHaveTextContent('Не вдалося завантажити статистику читання.')
    expect(within(section()).queryByText('Не читав')).not.toBeInTheDocument()
    await expectStatus(PANEL, 'Прочитано')

    await user.click(within(alert).getByRole('button', { name: 'Спробувати ще раз' }))

    await expectCounts(0, 0, 2)
  })

  it('a stats read sent before the save and answered after it does not put the old counts back', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')

    // A read of the old counts goes out (a refresh on focus would do the same) and is held back.
    holdNext.add(STATS_PATH)
    act(() => {
      void client?.refetchQueries({ queryKey: readingStatsQueryKey('user-a') })
    })
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    await chooseOption(user, PANEL, 'Прочитано')
    await expectCounts(0, 0, 2)

    await act(async () => {
      held[0]?.release()
      await Promise.resolve()
    })

    await expectCounts(0, 0, 2)
    expect(client?.getQueryData(readingStatsQueryKey('user-a'))).toEqual({
      counts: { NOT_READ: 0, READING: 0, READ: 2 },
    })
  })

  it('home → elsewhere → save → back home: the new counts, never the old ones first', async () => {
    const user = userEvent.setup()
    const { container } = renderApp()

    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')

    await user.click(screen.getByRole('button', { name: 'leave-home' }))
    expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()

    await chooseOption(user, PANEL, 'Прочитано')
    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()
    // Nobody is looking at the counts: they are marked out of date, not read.
    expect(requests(STATS_PATH)).toHaveLength(1)

    const frames = recordStats(container)

    await user.click(screen.getByRole('button', { name: 'back-home' }))

    await expectCounts(0, 0, 2)
    expect(requests(STATS_PATH)).toHaveLength(2)
    expect(frames.filter((frame) => /Читаю\s*1/.test(frame))).toEqual([])
  })

  it('a stats read in flight while nobody watches (a prefetch, say) does not land after the save', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)
    await expectStatus(PANEL, 'Читаю')
    await user.click(screen.getByRole('button', { name: 'leave-home' }))

    // Started with home unmounted, so leaving home cannot abort it, and invalidation only refetches
    // what is on screen.
    holdNext.add(STATS_PATH)
    act(() => {
      void client?.refetchQueries({ queryKey: readingStatsQueryKey('user-a'), type: 'inactive' })
    })
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    await chooseOption(user, PANEL, 'Прочитано')
    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()

    await act(async () => {
      held[0]?.release()
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: 'back-home' }))

    await expectCounts(0, 0, 2)
  })
})

describe('the first mount of home after a save, with a snapshot read before it (BS-145)', () => {
  /** What the server read before the save: A's counts while w-1 was still «Читаю». */
  const OLD_SNAPSHOT: ReadingStatsSnapshot = {
    status: 'ready',
    userId: 'user-a',
    data: { counts: { NOT_READ: 0, READING: 1, READ: 1 } },
  }

  it('an empty cache, a confirmed save, then home: the current counts, never the snapshot', async () => {
    const user = userEvent.setup()
    const { container } = renderApp({ isAway: true, initial: OLD_SNAPSHOT })

    await expectStatus(PANEL, 'Читаю')
    await chooseOption(user, PANEL, 'Прочитано')
    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()
    // Nobody looks at the counts yet: nothing is read for them.
    expect(requests(STATS_PATH)).toEqual([])

    const frames = recordStats(container)

    await user.click(screen.getByRole('button', { name: 'back-home' }))

    await expectCounts(0, 0, 2)
    expect(requests(STATS_PATH)).toHaveLength(1)
    expect(frames.filter((frame) => /Читаю\s*1/.test(frame))).toEqual([])
  })

  it('without a save the snapshot is the counts, and nothing is asked', async () => {
    const user = userEvent.setup()

    renderApp({ isAway: true, initial: OLD_SNAPSHOT })
    await expectStatus(PANEL, 'Читаю')

    await user.click(screen.getByRole('button', { name: 'back-home' }))

    await expectCounts(0, 1, 1)
    expect(requests(STATS_PATH)).toEqual([])
  })

  it('a failed save changes nothing: the snapshot is still the counts, and nothing is asked', async () => {
    const user = userEvent.setup()

    renderApp({ isAway: true, initial: OLD_SNAPSHOT })
    await expectStatus(PANEL, 'Читаю')

    failNext.add(STATUS_PATH)
    await chooseOption(user, PANEL, 'Прочитано')
    expect(await screen.findByRole('button', { name: 'Спробувати ще раз' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'back-home' }))

    await expectCounts(0, 1, 1)
    expect(requests(STATS_PATH)).toEqual([])
  })

  it('a save of the previous account marks nothing for the next one', async () => {
    const user = userEvent.setup()

    renderApp({
      isAway: true,
      initial: {
        ...OLD_SNAPSHOT,
        userId: 'user-b',
        data: { counts: { NOT_READ: 1, READING: 0, READ: 0 } },
      },
    })
    await expectStatus(PANEL, 'Читаю')
    await chooseOption(user, PANEL, 'Прочитано')
    expect(await screen.findByText('Збережено: «Прочитано».')).toBeInTheDocument()

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => {
      expect(screen.getByTestId('who')).toHaveTextContent('user-b')
    })
    await user.click(screen.getByRole('button', { name: 'back-home' }))

    // B's own snapshot seeds B's entry as usual.
    await expectCounts(1, 0, 0)
    expect(requests(STATS_PATH)).toEqual([])
  })
})

describe('home counts across an account change (BS-145)', () => {
  it('A → B through session.reload(): B’s counts load, A’s are never shown for B', async () => {
    const user = userEvent.setup()
    const { container } = renderApp()

    await expectCounts(0, 1, 1)

    const frames = recordStats(container)

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))

    await expectCounts(1, 0, 0)
    expect(screen.getByTestId('who')).toHaveTextContent('user-b')
    expect(frames.filter((frame) => /Прочитано\s*1/.test(frame))).toEqual([])
  })

  it('logout hides the block; another account signing in gets its own counts without a reload', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)

    signedIn = null
    await user.click(screen.getByRole('button', { name: 'logout' }))
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()
    })

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'login-b' }))

    await expectCounts(1, 0, 0)
  })

  it('A’s stats read that lands after the switch neither shows for B nor returns to the cache', async () => {
    const user = userEvent.setup()

    renderApp()
    await expectCounts(0, 1, 1)

    holdNext.add(STATS_PATH)
    act(() => {
      void client?.refetchQueries({ queryKey: readingStatsQueryKey('user-a') })
    })
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    signedIn = 'user-b'
    await user.click(screen.getByRole('button', { name: 'reload' }))
    await expectCounts(1, 0, 0)

    await act(async () => {
      held[0]?.release()
      await Promise.resolve()
    })

    await expectCounts(1, 0, 0)
    expect(client?.getQueryData(readingStatsQueryKey('user-a'))).toBeUndefined()
  })

  it('a server snapshot read for A is never shown nor cached when the tab turns out to be B’s', async () => {
    signedIn = 'user-b'

    // Recording from the very first frame, before the session is known.
    const container = document.body.appendChild(document.createElement('div'))
    const frames = recordStats(container)

    renderApp({
      initial: {
        status: 'ready',
        userId: 'user-a',
        data: { counts: { NOT_READ: 0, READING: 5, READ: 5 } },
      },
      container,
    })

    await expectCounts(1, 0, 0)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.filter((frame) => frame.includes('5'))).toEqual([])
    expect(client?.getQueryData(readingStatsQueryKey('user-a'))).toBeUndefined()
  })
})
