/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Me } from '@bookswap/shared'
import { SessionProvider, useSession } from './use-session'

/** Session contract (10f.2, T9): the REAL fetch + shared schema, so a malformed `features` fails here. */

const me: Me = {
  id: 'user-1',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Reader',
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
}

/** jsdom has no `Response`; `apiRequest` only reads these four members. */
function respondWith(body: unknown, status = 200): void {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      status,
      ok: status < 400,
      redirected: false,
      json: () => Promise.resolve(body),
    }),
  ) as unknown as typeof fetch
}

function Probe() {
  const { state, setUser } = useSession()

  if (state.status !== 'authenticated') return <p>{state.status}</p>

  return (
    <>
      <p>guestLoans={String(state.features?.guestLoans)}</p>
      <button
        type="button"
        onClick={() => {
          setUser({ ...me, displayName: 'Renamed' })
        }}
      >
        profile-update
      </button>
      <button
        type="button"
        onClick={() => {
          setUser(me, { guestLoans: false })
        }}
      >
        relogin-off
      </button>
    </>
  )
}

const renderProbe = () =>
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  )

describe('session features', () => {
  it.each([true, false])(
    'GET /auth/session: guestLoans=%s reaches the state',
    async (guestLoans) => {
      respondWith({ user: me, features: { guestLoans } })
      renderProbe()

      expect(await screen.findByText(`guestLoans=${String(guestLoans)}`)).toBeInTheDocument()
    },
  )

  it('a response without features breaks the contract instead of enabling anything', async () => {
    respondWith({ user: me })
    renderProbe()

    expect(await screen.findByText('error')).toBeInTheDocument()
  })

  it('a profile update keeps known features; a login supplies new ones', async () => {
    respondWith({ user: me, features: { guestLoans: true } })
    renderProbe()
    await screen.findByText('guestLoans=true')

    await userEvent.click(screen.getByRole('button', { name: 'profile-update' }))
    expect(screen.getByText('guestLoans=true')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'relogin-off' }))
    expect(screen.getByText('guestLoans=false')).toBeInTheDocument()
  })
})

/** BS-148: a profile answer reaches the session only while its user is the one signed in. */
function UpdateProbe() {
  const { state, setGuest, setUser, updateUser } = useSession()

  return (
    <>
      <p>
        {state.status === 'authenticated'
          ? `${state.user.id}: ${state.user.displayName}, ${String(state.user.avatarUrl)}, guestLoans=${String(state.features?.guestLoans)}`
          : state.status}
      </p>
      <button
        type="button"
        onClick={() => {
          updateUser(me.id, { displayName: 'Renamed' })
          updateUser(me.id, { avatarUrl: 'https://avatars.example/a.webp' })
        }}
      >
        two-answers
      </button>
      <button
        type="button"
        onClick={() => {
          setGuest()
          updateUser(me.id, { displayName: 'Renamed' })
        }}
      >
        logout-then-answer
      </button>
      <button
        type="button"
        onClick={() => {
          setUser({ ...me, id: 'user-2', displayName: 'Other' })
          updateUser(me.id, { displayName: 'Renamed' })
        }}
      >
        relogin-then-answer
      </button>
    </>
  )
}

describe('updateUser', () => {
  const renderUpdateProbe = async () => {
    respondWith({ user: me, features: { guestLoans: true } })
    render(
      <SessionProvider>
        <UpdateProbe />
      </SessionProvider>,
    )
    await screen.findByText('user-1: Reader, null, guestLoans=true')
  }

  it('merges each answer’s fields into the signed-in user, keeping the rest and the features', async () => {
    await renderUpdateProbe()

    await userEvent.click(screen.getByRole('button', { name: 'two-answers' }))

    expect(
      screen.getByText('user-1: Renamed, https://avatars.example/a.webp, guestLoans=true'),
    ).toBeInTheDocument()
  })

  it('an answer after a logout — even in the same tick — does not bring the user back', async () => {
    await renderUpdateProbe()

    await userEvent.click(screen.getByRole('button', { name: 'logout-then-answer' }))

    expect(screen.getByText('guest')).toBeInTheDocument()
  })

  it('an answer about the previous account does not touch the new one', async () => {
    await renderUpdateProbe()

    await userEvent.click(screen.getByRole('button', { name: 'relogin-then-answer' }))

    expect(screen.getByText('user-2: Other, null, guestLoans=true')).toBeInTheDocument()
  })
})
