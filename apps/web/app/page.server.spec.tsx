/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import HomePage from './page'

/**
 * BS-145: the home page stays a server component that only composes — the stats are read on the
 * server and handed to their client leaf, and the rest of the page is what it was.
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

jest.mock('@/components/DEV/HealthStatus', () => ({
  HealthStatus: () => <p>Health boundary</p>,
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
})

describe('page composition', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it.each(['ready', 'guest', 'error'])(
    'reads the stats once on the server and hands the %s snapshot to the block, keeping the rest',
    async (status) => {
      mockFetch.mockResolvedValue({ status })

      render(await HomePage())

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(screen.getByText(`Stats seed: ${status}`)).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 1, name: 'BookSwap' })).toBeInTheDocument()
      expect(screen.getByText(/Сервіс обміну фізичними книжками/)).toBeInTheDocument()
      expect(screen.getByText('Health boundary')).toBeInTheDocument()
    },
  )

  it('places «what my friends are reading» right after the reading stats and before HealthStatus (BS-137)', async () => {
    mockFetch.mockResolvedValue({ status: 'ready' })

    render(await HomePage())

    const stats = screen.getByText('Stats seed: ready')
    const friends = screen.getByText('Friends reading')

    expect(stats.nextElementSibling).toBe(friends)
    expect(friends.nextElementSibling).toBe(screen.getByText('Health boundary'))
  })
})
