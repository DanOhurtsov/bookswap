/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Me } from '@bookswap/shared'
import type { SessionState } from './use-session'
import { Providers } from './query-client'

/**
 * §3.9/R12: one `QueryClient` per browser tab, cache cleared on identity
 * change (different account, or logout) so a relogin in the same tab never
 * shows the previous person's cached data.
 */

let sessionState: SessionState = { status: 'loading' }

jest.mock('./use-session', () => ({
  useSession: () => ({ state: sessionState, reload: jest.fn(), setUser: jest.fn() }),
}))

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

/**
 * `getQueryClient().getQueryData` is a plain read, not a subscription — real
 * consumers (`useQuery`) do react to `clear()` on their own, but this probe
 * exists to check the cache's actual content right after `Providers`'s effect
 * runs, not to re-test react-query's own subscription plumbing. The "read"
 * button re-renders without touching the cache, forcing a fresh read.
 */
function Probe() {
  const client = useQueryClient()
  const [, rerenderProbe] = useState(0)
  const cached = client.getQueryData<string>(['probe'])

  return (
    <div>
      <span data-testid="probe">{cached ?? 'empty'}</span>
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
  sessionState = { status: 'loading' }
})

it('перше визначення сесії (loading → authenticated) не чистить кеш', async () => {
  const user = userEvent.setup()
  const { rerender } = render(
    <Providers>
      <Probe />
    </Providers>,
  )

  sessionState = { status: 'authenticated', user: me('user-a') }
  rerender(
    <Providers>
      <Probe />
    </Providers>,
  )

  await user.click(screen.getByText('seed'))
  expect(screen.getByTestId('probe')).toHaveTextContent('private-data')
})

it('логін під іншим акаунтом в тій самій вкладці чистить кеш', async () => {
  const user = userEvent.setup()
  sessionState = { status: 'authenticated', user: me('user-a') }

  const { rerender } = render(
    <Providers>
      <Probe />
    </Providers>,
  )

  await user.click(screen.getByText('seed'))
  expect(screen.getByTestId('probe')).toHaveTextContent('private-data')

  sessionState = { status: 'authenticated', user: me('user-b') }
  rerender(
    <Providers>
      <Probe />
    </Providers>,
  )
  await user.click(screen.getByText('read'))

  expect(screen.getByTestId('probe')).toHaveTextContent('empty')
})

it('logout у тій самій вкладці теж чистить кеш', async () => {
  const user = userEvent.setup()
  sessionState = { status: 'authenticated', user: me('user-a') }

  const { rerender } = render(
    <Providers>
      <Probe />
    </Providers>,
  )

  await user.click(screen.getByText('seed'))
  expect(screen.getByTestId('probe')).toHaveTextContent('private-data')

  sessionState = { status: 'guest' }
  rerender(
    <Providers>
      <Probe />
    </Providers>,
  )
  await user.click(screen.getByText('read'))

  expect(screen.getByTestId('probe')).toHaveTextContent('empty')
})
