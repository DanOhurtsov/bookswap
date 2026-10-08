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
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: false,
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
