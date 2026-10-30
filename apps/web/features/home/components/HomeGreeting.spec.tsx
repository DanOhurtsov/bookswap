/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { SessionState } from '@/app/lib/use-session'
import { HomeGreeting } from './HomeGreeting'

/** BS-147: the greeting at the top of the home page, by role and text. The session is replaced. */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let session: SessionState

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: session }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const LEDE = /Сервіс обміну фізичними книжками/

function signedIn(id: string, displayName: string): SessionState {
  return { status: 'authenticated', user: { id, displayName } } as SessionState
}

function expectGuestText(): void {
  expect(screen.getByRole('heading', { level: 1, name: 'BookSwap' })).toBeInTheDocument()
  expect(screen.getByText(LEDE)).toBeInTheDocument()
}

beforeEach(() => {
  apiRequest.mockReset()
})

describe('HomeGreeting', () => {
  it('greets a signed-in reader by the first word of their name, without the description', () => {
    session = signedIn('user-a', 'Данило Огурцов')

    render(<HomeGreeting knownGuest={false} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Вітаємо, Данило' })).toBeInTheDocument()
    expect(screen.queryByText(LEDE)).not.toBeInTheDocument()
  })

  it('greets without a name when the display name has no word', () => {
    session = signedIn('user-a', '   ')

    render(<HomeGreeting knownGuest={false} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Вітаємо!' })).toBeInTheDocument()
  })

  it('greets the new reader after another account signs in, in the same mount', () => {
    session = signedIn('user-a', 'Данило Огурцов')
    const { rerender } = render(<HomeGreeting knownGuest={false} />)

    session = signedIn('user-b', 'Марта Коваль')
    rerender(<HomeGreeting knownGuest={false} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Вітаємо, Марта' })).toBeInTheDocument()
    expect(screen.queryByText(/Данило/)).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'shows a guest the service title and description (server knew of no session: %p)',
    (knownGuest) => {
      session = { status: 'guest' }

      render(<HomeGreeting knownGuest={knownGuest} />)

      expectGuestText()
    },
  )

  it('shows the guest text when the session could not be read', () => {
    session = { status: 'error', message: 'Немає звʼязку' }

    render(<HomeGreeting knownGuest={false} />)

    expectGuestText()
  })

  it('shows the guest text at once while the session loads, if the server knew of no session', () => {
    session = { status: 'loading' }

    render(<HomeGreeting knownGuest />)

    expectGuestText()
  })

  it('holds the line with a placeholder, and no heading, while a possible reader’s session loads', () => {
    session = { status: 'loading' }

    const { container } = render(<HomeGreeting knownGuest={false} />)

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText(LEDE)).not.toBeInTheDocument()
    expect(container.querySelector("[data-slot='skeleton']")).toHaveAttribute('aria-hidden', 'true')
  })

  it('sends no requests in any state', () => {
    const states: SessionState[] = [
      { status: 'loading' },
      { status: 'guest' },
      { status: 'error', message: 'x' },
      signedIn('user-a', 'Данило'),
    ]

    for (const state of states) {
      session = state
      render(<HomeGreeting knownGuest={false} />).unmount()
    }

    expect(apiRequest).not.toHaveBeenCalled()
  })
})
