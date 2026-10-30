/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import HomePage from './page'

/**
 * BS-145: the home page stays a server component that only composes — the stats are read on the
 * server and handed to their client leaf. BS-147: the greeting tops the page and learns from the same
 * snapshot whether the server saw a guest; the DEV health block is no longer on it.
 */
jest.mock('@/features/reading-status', () => ({
  fetchReadingStatsSnapshot: jest.fn(),
}))

jest.mock('@/features/reading-status/index.client', () => ({
  HomeReadingStats: ({ initial }: { initial: { status: string } }) => (
    <p>Stats seed: {initial.status}</p>
  ),
}))

jest.mock('@/features/friends-reading/index.client', () => ({
  FriendsReading: () => <p>Friends reading</p>,
}))

jest.mock('@/features/home/index.client', () => ({
  HomeGreeting: ({ knownGuest }: { knownGuest: boolean }) => (
    <p>Greeting, known guest: {String(knownGuest)}</p>
  ),
}))

const { fetchReadingStatsSnapshot: mockFetch } = jest.requireMock<{
  fetchReadingStatsSnapshot: jest.Mock
}>('@/features/reading-status')

const source = readFileSync(__filename.replace('page.server.spec.tsx', 'page.tsx'), 'utf8')

describe('the / route stays routing-only', () => {
  it('is not a client component and fits in 50 lines', () => {
    expect(source).not.toContain("'use client'")
    expect(source.split('\n').length).toBeLessThanOrEqual(50)
  })

  it('holds no stats UI or state of its own', () => {
    expect(source).not.toMatch(/useState|useQuery|Не читав|Прочитано/)
  })

  it('no longer shows the DEV health block (BS-147)', () => {
    expect(source).not.toContain('HealthStatus')
  })
})

describe('page composition', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it.each([
    ['ready', false],
    ['guest', true],
    ['error', false],
  ])(
    'reads the stats once on the server, hands the %s snapshot to the block and tells the greeting',
    async (status, knownGuest) => {
      mockFetch.mockResolvedValue({ status })

      render(await HomePage())

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(screen.getByText(`Stats seed: ${status}`)).toBeInTheDocument()
      expect(screen.getByText(`Greeting, known guest: ${String(knownGuest)}`)).toBeInTheDocument()
    },
  )

  it('orders the page: greeting, reading stats, «what my friends are reading» (BS-137, BS-147)', async () => {
    mockFetch.mockResolvedValue({ status: 'ready' })

    render(await HomePage())

    const greeting = screen.getByText(/Greeting, known guest/)
    const stats = screen.getByText('Stats seed: ready')
    const friends = screen.getByText('Friends reading')

    expect(greeting.nextElementSibling).toBe(stats)
    expect(stats.nextElementSibling).toBe(friends)
    expect(friends.nextElementSibling).toBeNull()
  })
})
