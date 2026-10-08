/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BorrowedLibraryResponse, LibraryResponse } from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import { LibraryScreen } from './LibraryScreen'

/**
 * Where a book on the shelf leads. The owner's own copies open the owner's page of the copy
 * (`/library/:copyId`); other people's books keep the general page of the work.
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'user-1' } },
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const AUTHOR = { id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }

const BOOK = {
  work: { id: 'work-1', title: 'Шантарам', origLang: 'en', firstPubYear: null, authors: [AUTHOR] },
  edition: {
    id: 'edition-1',
    workId: 'work-1',
    translationId: null,
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    translation: null,
  },
  authors: [AUTHOR],
}

function ownCopy(id: string) {
  return {
    id,
    status: 'AVAILABLE',
    visibility: 'FRIENDS',
    condition: 'GOOD',
    note: null,
    acquiredAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    isHome: true,
    holder: null,
    activeLoan: null,
    pendingRequestCount: 0,
  }
}

function shelf(...copyIds: string[]): LibraryResponse {
  return {
    groups: [
      {
        ...BOOK,
        copies: copyIds.map(ownCopy),
        counts: { total: copyIds.length, home: copyIds.length, out: 0 },
      },
    ],
  } as unknown as LibraryResponse
}

const BORROWED = {
  groups: [
    {
      ...BOOK,
      copies: [
        {
          id: 'copy-7',
          status: 'LENT_OUT',
          condition: 'WORN',
          owner: { id: 'user-2', displayName: 'Марко', avatarUrl: null },
          activeLoan: null,
        },
      ],
      counts: { total: 1, home: 0, out: 1 },
    },
  ],
} as unknown as BorrowedLibraryResponse

function serve(routes: Record<string, unknown>): void {
  mockApiRequest.mockImplementation((path: string) => {
    if (path in routes) return Promise.resolve(routes[path])

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('куди веде книга на полиці', () => {
  it('«Усі мої»: заголовок веде на сторінку першого примірника, а не на сторінку твору', async () => {
    serve({ '/me/library': shelf('copy-1', 'copy-2') })

    render(withQueryClient(<LibraryScreen />))

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/library/copy-1',
    )
  })

  it.each([
    ['Мої не вдома', '/me/library/out'],
    ['Архів', '/me/library?archived=true'],
  ])('«%s»: книга теж веде на /library/:copyId', async (tab, path) => {
    serve({ '/me/library': shelf(), [path]: shelf('copy-9') })

    render(withQueryClient(<LibraryScreen />))
    await userEvent.click(await screen.findByRole('tab', { name: tab }))

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/library/copy-9',
    )
  })

  it('«Чужі в мене»: книга лишається на загальній сторінці твору', async () => {
    serve({ '/me/library': shelf(), '/me/library/borrowed': BORROWED })

    render(withQueryClient(<LibraryScreen />))
    await userEvent.click(await screen.findByRole('tab', { name: 'Чужі в мене' }))

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/works/work-1',
    )
  })
})
