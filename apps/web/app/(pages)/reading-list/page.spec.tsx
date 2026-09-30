/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Me, ReadingListResponse } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import { NAVBAR_PROFILE_LINKS } from '@/constants/navigation'
import ReadingListPage from './page'

/** RS14 (10j.2): the reading list is a signed-in, navigable page; a guest is sent to login. */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let session: SessionState = { status: 'loading' }

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: session, reload: jest.fn(), setUser: jest.fn() }),
}))

const replace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function user(id: string): Me {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    displayName: `Користувач ${id}`,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function listOf(title: string): ReadingListResponse {
  return {
    items: [
      {
        work: {
          id: `w-${title}`,
          title,
          origLang: 'uk',
          firstPubYear: null,
          description: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
        },
        authors: [],
        status: 'READ',
        wasBorrowed: true,
        updatedAt: '2026-09-30T10:00:00.000Z',
      },
    ],
    nextCursor: null,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockResolvedValue({ items: [], nextCursor: null })
})

describe('Reading list page', () => {
  it('is linked from the profile navigation', () => {
    expect(NAVBAR_PROFILE_LINKS).toContainEqual({ href: '/reading-list', label: 'Список читання' })
  })

  it('a guest is redirected to login and no list request is sent', async () => {
    session = { status: 'guest' }

    render(<ReadingListPage />)

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login')
    })
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('a signed-in viewer gets the list with its empty state', async () => {
    session = { status: 'authenticated', user: user('me') }

    render(<ReadingListPage />)

    expect(screen.getByRole('heading', { name: 'Список читання' })).toBeInTheDocument()
    expect(await screen.findByText(/Тут поки порожньо/)).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith('/me/reading-list', expect.anything())
  })
  it('a session switch A → B on the mounted page drops A’s list at once and asks again for B', async () => {
    session = { status: 'authenticated', user: user('a') }

    // Each request is answered for the session that is current WHEN it is sent — like a cookie.
    let settleB: (value: ReadingListResponse) => void = () => undefined
    const requestedBy: string[] = []

    apiRequest.mockImplementation(() => {
      const viewer = session.status === 'authenticated' ? session.user.id : 'none'

      requestedBy.push(viewer)

      return viewer === 'a'
        ? Promise.resolve(listOf('Книжка A'))
        : new Promise((resolve) => {
            settleB = resolve
          })
    })

    const { rerender } = render(<ReadingListPage />)

    expect(await screen.findByRole('link', { name: 'Книжка A' })).toBeInTheDocument()

    session = { status: 'authenticated', user: user('b') }
    rerender(<ReadingListPage />)

    // Before B's answer: nothing of A's is left on screen.
    expect(screen.queryByRole('link', { name: 'Книжка A' })).not.toBeInTheDocument()
    expect(screen.queryByText('Була позичена')).not.toBeInTheDocument()
    expect(screen.getByText('Завантажую…')).toBeInTheDocument()
    await waitFor(() => {
      expect(requestedBy).toEqual(['a', 'b'])
    })

    await act(async () => {
      settleB(listOf('Книжка B'))
      await Promise.resolve()
    })

    expect(await screen.findByRole('link', { name: 'Книжка B' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Книжка A' })).not.toBeInTheDocument()
  })
})
