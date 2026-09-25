/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ResolveInvitationResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { InviteAcceptance } from './InviteAcceptance'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let sessionState: { status: string; message?: string } = { status: 'authenticated' }

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: sessionState }),
}))

const replace = jest.fn()

// A stable router object, as in Next: the component's effect depends on it.
const router = { replace }

jest.mock('next/navigation', () => ({ useRouter: () => router }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const inviter = { id: 'inv-1', displayName: 'Марта', avatarUrl: null }

function resolved(over: Partial<ResolveInvitationResponse> = {}): ResolveInvitationResponse {
  return { state: 'ACTIVE', inviter, relation: 'NONE', ...over }
}

function apiError(code: string, status: number): ApiRequestError {
  return new ApiRequestError(status, { code, message: code } as never)
}

function open(hash: string): void {
  window.history.replaceState(null, '', `/invite${hash}`)
}

beforeEach(() => {
  jest.clearAllMocks()
  sessionState = { status: 'authenticated' }
  window.sessionStorage.clear()
  apiRequest.mockResolvedValue(resolved())
  open('#tok-123')
})

const calls = (path: string): unknown[][] =>
  apiRequest.mock.calls.filter(([p]: [string]) => p === path)

describe('InviteAcceptance', () => {
  it('guest: stashes the token and goes to login with returnTo, without calling the API', async () => {
    sessionState = { status: 'guest' }
    render(<InviteAcceptance />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?returnTo=/invite'))
    expect(window.sessionStorage.getItem('bookswap.invite-token')).toBe('tok-123')
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('resumes from the stash after login, then clears it and the fragment', async () => {
    open('')
    window.sessionStorage.setItem('bookswap.invite-token', 'stashed')
    render(<InviteAcceptance />)

    expect(await screen.findByRole('button', { name: 'Прийняти дружбу' })).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(
      '/invitations/resolve',
      expect.objectContaining({ body: { token: 'stashed' } }),
    )
    expect(window.sessionStorage.getItem('bookswap.invite-token')).toBeNull()
  })

  it('strips the fragment from the address once it is read', async () => {
    render(<InviteAcceptance />)
    await screen.findByRole('button', { name: 'Прийняти дружбу' })

    expect(window.location.hash).toBe('')
  })

  it('shows the inviter and never accepts before an explicit click', async () => {
    render(<InviteAcceptance />)

    expect(await screen.findByText('Марта')).toBeInTheDocument()
    expect(calls('/invitations/accept')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Прийняти дружбу' }))

    await waitFor(() => expect(calls('/invitations/accept')).toHaveLength(1))
  })

  it('accept success links to the inviter library and the catalog', async () => {
    render(<InviteAcceptance />)
    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/invitations/accept' ? { relation: 'FRIENDS', inviter } : resolved(),
      ),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Прийняти дружбу' }))

    expect(await screen.findByText(/Тепер ви друзі з Марта/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Переглянути бібліотеку' })).toHaveAttribute(
      'href',
      '/users/inv-1/library',
    )
  })

  it('«Не зараз» creates nothing', async () => {
    render(<InviteAcceptance />)
    await userEvent.click(await screen.findByRole('button', { name: 'Не зараз' }))

    expect(screen.getByText(/дружбу не створено/)).toBeInTheDocument()
    expect(calls('/invitations/accept')).toHaveLength(0)
  })

  it('already friends: no accept button', async () => {
    apiRequest.mockResolvedValue(resolved({ relation: 'FRIENDS' }))
    render(<InviteAcceptance />)

    expect(await screen.findByText(/Ви вже друзі/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Прийняти дружбу' })).not.toBeInTheDocument()
  })

  it.each([
    ['EXPIRED', /Строк дії/],
    ['REVOKED', /відкликав/],
    ['EXHAUSTED', /використано максимальну/],
    ['SELF', /власне запрошення/],
    ['ALREADY_ACCEPTED', /вже прийняли/],
  ] as const)('%s shows its message and no accept button', async (state, message) => {
    apiRequest.mockResolvedValue(resolved({ state }))
    render(<InviteAcceptance />)

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Прийняти дружбу' })).not.toBeInTheDocument()
  })

  it('INVITE_INVALID from resolve is a generic «недійсне»', async () => {
    apiRequest.mockRejectedValue(apiError('INVITE_INVALID', 404))
    render(<InviteAcceptance />)

    expect(await screen.findByText('Запрошення недійсне.')).toBeInTheDocument()
  })

  it('a 410 on accept turns into the matching terminal message', async () => {
    render(<InviteAcceptance />)
    apiRequest.mockImplementation((path: string) =>
      path === '/invitations/accept'
        ? Promise.reject(apiError('INVITE_EXPIRED', 410))
        : Promise.resolve(resolved()),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Прийняти дружбу' }))

    expect(await screen.findByText(/Строк дії/)).toBeInTheDocument()
  })

  it('no token anywhere: explains instead of calling the API', async () => {
    open('')
    render(<InviteAcceptance />)

    expect(await screen.findByText(/немає запрошення/)).toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('never renders the raw token', async () => {
    const { container } = render(<InviteAcceptance />)
    await screen.findByRole('button', { name: 'Прийняти дружбу' })

    expect(container.innerHTML).not.toContain('tok-123')
  })
})
