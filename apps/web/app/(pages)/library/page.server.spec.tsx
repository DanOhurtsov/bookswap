/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import LibraryPage from './page'

/**
 * Stage 8h-2: `/library` is the one server-first route, and this is what keeps
 * it one.
 *
 * Two halves. The source check (§1.1/§2.2) says the route file stays routing
 * only — no `'use client'`, nothing long enough to be a screen, and no UI left
 * behind under `app/`. The render check says the composition actually works:
 * the server read happens here, and its result reaches the checklist rather
 * than being fetched again below.
 */
jest.mock('@/features/library/activation', () => ({
  fetchActivationProgress: jest.fn(),
}))

jest.mock('@/features/library/activation/index.client', () => ({
  ActivationChecklist: ({ initial }: { initial?: { status: string } }) => (
    <p>Checklist seed: {initial?.status ?? 'none'}</p>
  ),
}))

jest.mock('@/features/library/own-library/index.client', () => ({
  LibraryScreen: ({ checklist }: { checklist?: React.ReactNode }) => (
    <div>
      <p>Library client boundary</p>
      {checklist}
    </div>
  ),
}))

const { fetchActivationProgress: mockFetch } = jest.requireMock<{
  fetchActivationProgress: jest.Mock
}>('@/features/library/activation')

const source = readFileSync(__filename.replace('page.server.spec.tsx', 'page.tsx'), 'utf8')

describe('маршрут /library лишається routing-only', () => {
  it('не є клієнтським компонентом', () => {
    expect(source).not.toContain("'use client'")
  })

  it('вміщується у 50 рядків', () => {
    expect(source.split('\n').length).toBeLessThanOrEqual(50)
  })

  it('не містить UI — жодної розмітки бібліотеки, лише композиція', () => {
    // The screen moved to the feature layer; anything that used to live here
    // (the shelf, the filters, the copy rows) must not have come back.
    expect(source).not.toContain('useState')
    expect(source).not.toContain('className')
    expect(source).not.toContain('Моя бібліотека')
  })

  it('основний UI лежить поза app/', () => {
    expect(source).toContain('@/features/library/own-library/index.client')
  })
})

describe('композиція сторінки', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('читає прогрес на сервері й віддає його чеклісту як початковий стан', async () => {
    mockFetch.mockResolvedValue({ status: 'ready', data: { ownedCopyCount: 4 } })

    render(await LibraryPage())

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Library client boundary')).toBeInTheDocument()
    expect(screen.getByText('Checklist seed: ready')).toBeInTheDocument()
  })

  it('невдале серверне читання не ламає бібліотеку', async () => {
    mockFetch.mockResolvedValue({ status: 'error' })

    render(await LibraryPage())

    expect(screen.getByText('Library client boundary')).toBeInTheDocument()
    expect(screen.getByText('Checklist seed: error')).toBeInTheDocument()
  })
})
