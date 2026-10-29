/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import type { Me, PublicUser, VisibleLibraryResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { LegacyPersonRedirect, PersonScreen } from './PersonScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

jest.mock('@/app/lib/use-session', () => ({ useSession: jest.fn() }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')
const { useSession } = jest.requireMock<{ useSession: jest.Mock }>('@/app/lib/use-session')

/** Her id and her nickname differ on purpose: a link built from the id would not pass. */
const MARTA: PublicUser = { id: 'user-2', displayName: 'Марта', handle: 'marta', avatarUrl: null }

const LIBRARY: VisibleLibraryResponse = { owner: MARTA, groups: [] }

function notFound(): ApiRequestError {
  return new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Користувача не знайдено' })
}

/** The API as these screens see it: the person by nickname or id, and her library by id. */
function serve(answers: Record<string, () => Promise<unknown>>): void {
  apiRequest.mockImplementation((path: string) => {
    const answer = answers[path]

    return answer === undefined ? Promise.reject(new Error(`unexpected ${path}`)) : answer()
  })
}

function requestedPaths(): string[] {
  return apiRequest.mock.calls.map(([path]) => path as string)
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  useSession.mockReturnValue({
    state: { status: 'authenticated', user: { id: 'viewer-1' } as Me },
    reload: jest.fn(),
  })
})

describe('PersonScreen: /u/<handle> (BS-148)', () => {
  it('finds the person by nickname, then shows her library', async () => {
    serve({
      '/users/handles/marta': () => Promise.resolve(MARTA),
      '/users/user-2/library': () => Promise.resolve(LIBRARY),
    })

    render(withQueryClient(<PersonScreen handle="marta" />))

    expect(await screen.findByRole('heading', { name: 'Бібліотека: Марта' })).toBeInTheDocument()
    expect(screen.getByText('Тут поки нічого не видно.')).toBeInTheDocument()
    expect(requestedPaths()).toEqual(['/users/handles/marta', '/users/user-2/library'])
  })

  it('asks for the nickname as it is stored: lowercase', async () => {
    serve({
      '/users/handles/marta': () => Promise.resolve(MARTA),
      '/users/user-2/library': () => Promise.resolve(LIBRARY),
    })

    render(withQueryClient(<PersonScreen handle="Marta" />))

    expect(await screen.findByRole('heading', { name: 'Бібліотека: Марта' })).toBeInTheDocument()
    expect(requestedPaths()[0]).toBe('/users/handles/marta')
  })

  it('an unknown or blocked person: «not found», and no library is asked for', async () => {
    serve({ '/users/handles/marta': () => Promise.reject(notFound()) })

    render(withQueryClient(<PersonScreen handle="marta" />))

    expect(await screen.findByText('Користувача не знайдено')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'До друзів' })).toHaveAttribute('href', '/friends')
    expect(requestedPaths()).toEqual(['/users/handles/marta'])
  })

  it('a nickname that cannot exist is «not found» without asking the server', () => {
    render(withQueryClient(<PersonScreen handle="a--b" />))

    expect(screen.getByText('Користувача не знайдено')).toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('a guest is sent to the login page before anything is asked', async () => {
    useSession.mockReturnValue({ state: { status: 'guest' }, reload: jest.fn() })

    render(withQueryClient(<PersonScreen handle="marta" />))

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })
    expect(apiRequest).not.toHaveBeenCalled()
  })
})

describe('LegacyPersonRedirect: /users/<id>/library (BS-148)', () => {
  it('replaces the old address with /u/<handle>, without loading the library', async () => {
    serve({ '/users/user-2': () => Promise.resolve(MARTA) })

    render(withQueryClient(<LegacyPersonRedirect userId="user-2" />))

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/u/marta')
    })
    expect(requestedPaths()).toEqual(['/users/user-2'])
  })

  it('an unknown or blocked person: «not found», and no redirect', async () => {
    serve({ '/users/user-2': () => Promise.reject(notFound()) })

    render(withQueryClient(<LegacyPersonRedirect userId="user-2" />))

    expect(await screen.findByText('Користувача не знайдено')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
