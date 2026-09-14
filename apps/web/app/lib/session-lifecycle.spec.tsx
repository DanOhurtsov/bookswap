/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiRequestError, apiRequest } from './api'
import { Providers } from './query-client'
import { SessionProvider, useSession } from './use-session'
import LoginPage from '../(pages)/login/page'
import RegisterPage from '../(pages)/register/page'
import ProfilePage from '../(pages)/profile/page'

/**
 * §8e-3 follow-up: the REAL `useSession`/`SessionProvider` (not mocked) —
 * proves login/logout propagate to every mounted consumer through the
 * shared context, and that `Providers` (query-client.tsx) actually observes
 * it instead of holding its own independent, never-updated session fetch.
 */

jest.mock('./api', () => {
  const actual = jest.requireActual<typeof import('./api')>('./api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('./api')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

/** A second, independent consumer of the SAME context — like `NavBar`. */
function SessionProbe() {
  const { state } = useSession()

  if (state.status === 'authenticated') return <p>Вітаю, {state.user.id}</p>

  return <p>Гість</p>
}

/**
 * Proves `Providers` reacts to the real context, not a fetch of its own.
 * Plain `getQueryData` + a manual re-render trigger — not `useQuery` — same
 * reason as `query-client.spec.tsx`'s `Probe`: a read during render does not
 *, by itself, re-run just because `queryClient.clear()` fired elsewhere.
 */
function CacheProbe() {
  const client = useQueryClient()
  const [, rerenderProbe] = useState(0)
  const cached = client.getQueryData<string>(['probe'])

  return (
    <div>
      <span data-testid="cache-probe">{cached ?? 'empty'}</span>
      <button
        type="button"
        onClick={() => {
          client.setQueryData(['probe'], 'private-data')
          rerenderProbe((value) => value + 1)
        }}
      >
        seed
      </button>
      <button
        type="button"
        onClick={() => {
          rerenderProbe((value) => value + 1)
        }}
      >
        read
      </button>
    </div>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

it('логін через реальну LoginPage одразу оновлює інший компонент через той самий контекст', async () => {
  const user = userEvent.setup()

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') {
      return Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
    }
    if (path === '/auth/login') {
      return Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })
    }

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  render(
    <SessionProvider>
      <LoginPage />
      <SessionProbe />
    </SessionProvider>,
  )

  expect(await screen.findByText('Гість')).toBeInTheDocument()

  await user.type(screen.getByLabelText('Email'), 'a@example.com')
  await user.type(screen.getByLabelText('Пароль'), 'correct horse battery staple')
  await user.click(screen.getByRole('button', { name: 'Увійти' }))

  // `SessionProbe` never called `/auth/session` itself for this — it saw the
  // new identity purely through the shared context that `LoginPage` updated.
  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-a')).toBeInTheDocument()
  })

  const sessionCalls = mockApiRequest.mock.calls.filter(([path]) => path === '/auth/session')

  expect(sessionCalls).toHaveLength(1)
})

it('logout (session.reload()) через реальний контекст чистить QueryClient у Providers', async () => {
  const user = userEvent.setup()
  let authenticated = true

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') {
      return authenticated
        ? Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })
        : Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
    }

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  function LogoutButton() {
    const { reload } = useSession()

    return (
      <button
        type="button"
        onClick={() => {
          authenticated = false
          reload()
        }}
      >
        logout
      </button>
    )
  }

  render(
    <SessionProvider>
      <Providers>
        <SessionProbe />
        <LogoutButton />
        <CacheProbe />
      </Providers>
    </SessionProvider>,
  )

  expect(await screen.findByText('Вітаю, user-a')).toBeInTheDocument()

  await user.click(screen.getByText('seed'))
  expect(screen.getByTestId('cache-probe')).toHaveTextContent('private-data')

  await user.click(screen.getByText('logout'))

  await waitFor(() => {
    expect(screen.getByText('Гість')).toBeInTheDocument()
  })

  await user.click(screen.getByText('read'))

  // `Providers` observed the SAME context transition and cleared its cache —
  // no separate, independent session fetch of its own to go stale.
  expect(screen.getByTestId('cache-probe')).toHaveTextContent('empty')
})

it('реєстрація через реальну RegisterPage переводить гостя в authenticated для всіх', async () => {
  const user = userEvent.setup()

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') {
      return Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
    }
    if (path === '/auth/register') {
      return Promise.resolve({ user: { id: 'user-new', displayName: 'New' } })
    }

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  render(
    <SessionProvider>
      <RegisterPage />
      <SessionProbe />
    </SessionProvider>,
  )

  expect(await screen.findByText('Гість')).toBeInTheDocument()

  await user.type(screen.getByLabelText('Імʼя'), 'New Person')
  await user.type(screen.getByLabelText('Email'), 'new@example.com')
  await user.type(screen.getByLabelText('Пароль'), 'correct horse battery staple')
  await user.click(screen.getByRole('button', { name: 'Створити акаунт' }))

  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-new')).toBeInTheDocument()
  })

  const sessionCalls = mockApiRequest.mock.calls.filter(([path]) => path === '/auth/session')

  expect(sessionCalls).toHaveLength(1)
})

it('затриманий GET, що завершується ПІСЛЯ login, не перезаписує новіший стан', async () => {
  const user = userEvent.setup()
  const delayedSessionGet = defer<{ user: { id: string; displayName: string } }>()

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') return delayedSessionGet.promise
    if (path === '/auth/login') return Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  render(
    <SessionProvider>
      <LoginPage />
      <SessionProbe />
    </SessionProvider>,
  )

  await user.type(screen.getByLabelText('Email'), 'a@example.com')
  await user.type(screen.getByLabelText('Пароль'), 'correct horse battery staple')
  await user.click(screen.getByRole('button', { name: 'Увійти' }))

  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-a')).toBeInTheDocument()
  })

  // The initial mount's `/auth/session` GET (still pending) finally answers —
  // with a DIFFERENT identity, to make an accidental overwrite obvious.
  delayedSessionGet.resolve({ user: { id: 'someone-else', displayName: 'X' } })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(screen.getByText('Вітаю, user-a')).toBeInTheDocument()
})

it('затриманий GET, що завершується ПІСЛЯ logout, не перезаписує новіший стан', async () => {
  const user = userEvent.setup()
  const delayedSessionGet = defer<{ user: { id: string; displayName: string } }>()
  let sessionGetCalls = 0

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') {
      sessionGetCalls += 1
      // Only the very first (mount-time) GET is the delayed one under test —
      // a real app would not issue a second one here, but guarding this way
      // keeps the mock simple regardless.
      return sessionGetCalls === 1
        ? delayedSessionGet.promise
        : Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })
    }
    if (path === '/auth/logout') return Promise.resolve(undefined)

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  function LogoutButton() {
    const { setGuest } = useSession()

    return (
      <button
        type="button"
        onClick={() => {
          void apiRequest('/auth/logout', { method: 'POST' }).then(() => {
            setGuest()
          })
        }}
      >
        logout
      </button>
    )
  }

  render(
    <SessionProvider>
      <SessionProbe />
      <LogoutButton />
    </SessionProvider>,
  )

  await user.click(screen.getByText('logout'))

  await waitFor(() => {
    expect(screen.getByText('Гість')).toBeInTheDocument()
  })

  // The delayed mount-time GET finally answers as authenticated — must not
  // resurrect a session the user just explicitly logged out of.
  delayedSessionGet.resolve({ user: { id: 'user-a', displayName: 'A' } })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(screen.getByText('Гість')).toBeInTheDocument()
})

it('невдалий logout не переводить у guest і показує помилку, а не редиректить', async () => {
  const user = userEvent.setup()

  const me = {
    id: 'user-a',
    email: 'a@example.com',
    emailVerified: true,
    displayName: 'A',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  }

  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/auth/session') return Promise.resolve({ user: me })
    if (path === '/auth/logout') {
      return Promise.reject(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'бум' }))
    }

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })

  render(
    <SessionProvider>
      <ProfilePage />
    </SessionProvider>,
  )

  expect(await screen.findByText('a@example.com')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Вийти' }))

  expect(await screen.findByText('бум')).toBeInTheDocument()
  // Still on the profile page, still showing the authenticated user — a
  // failed logout must not look like a confirmed one.
  expect(screen.getByText('a@example.com')).toBeInTheDocument()
  expect(mockReplace).not.toHaveBeenCalled()
})
