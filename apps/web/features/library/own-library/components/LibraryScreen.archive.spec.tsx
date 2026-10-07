/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { LibraryResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { ACTIVATION_QUERY_KEY } from '@/features/library/activation/index.client'
import { LibraryScreen } from './LibraryScreen'

/**
 * Stage 10, 10c: «Архівувати» на активному примірнику і «Відновити» в архіві. Архів — окремий
 * перегляд (`GET /me/library?archived=true`), у якому немає ні редагування, ні видалення.
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

let searchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => searchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  mockApiRequest.mockReset()
  searchParams = new URLSearchParams()
})

const AUTHOR = { id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }

function library(copyId: string): LibraryResponse {
  return {
    groups: [
      {
        work: {
          id: 'work-1',
          title: 'Шантарам',
          origLang: 'en',
          firstPubYear: null,
          authors: [AUTHOR],
        },
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
        copies: [
          {
            id: copyId,
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
          },
        ],
        counts: { total: 1, home: 1, out: 0 },
      },
    ],
  } as unknown as LibraryResponse
}

const EMPTY: LibraryResponse = { groups: [] }

describe('архів у бібліотеці (10c)', () => {
  it('«Архівувати» робить POST …/archive, інвалідує activation і перезавантажує полицю', async () => {
    const client = createTestQueryClient()
    const invalidate = jest.spyOn(client, 'invalidateQueries')

    mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? Promise.resolve({}) : Promise.resolve(library('copy-1')),
    )

    render(withQueryClient(<LibraryScreen />, client))
    await userEvent.click(await screen.findByRole('button', { name: 'Архівувати' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library/copy-1/archive',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    await waitFor(() => {
      expect(
        invalidate.mock.calls.filter(
          ([options]) =>
            JSON.stringify((options as { queryKey?: unknown }).queryKey) ===
            JSON.stringify(ACTIVATION_QUERY_KEY),
        ),
      ).toHaveLength(1)
    })
  })

  it('відмова 409 показує повідомлення й не інвалідує activation', async () => {
    const client = createTestQueryClient()
    const invalidate = jest.spyOn(client, 'invalidateQueries')

    mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === 'POST'
        ? Promise.reject(
            new ApiRequestError(409, {
              code: 'COPY_HAS_ACTIVE_LOAN',
              message: 'Примірник не можна архівувати: він зараз у позичанні',
            }),
          )
        : Promise.resolve(library('copy-1')),
    )

    render(withQueryClient(<LibraryScreen />, client))
    await userEvent.click(await screen.findByRole('button', { name: 'Архівувати' }))

    expect(await screen.findByText(/він зараз у позичанні/)).toBeInTheDocument()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('вкладка «Архів» читає ?archived=true, показує лише «Відновити» й відновлює', async () => {
    const client = createTestQueryClient()

    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return Promise.resolve({})
      return Promise.resolve(path === '/me/library?archived=true' ? library('copy-9') : EMPTY)
    })

    render(withQueryClient(<LibraryScreen />, client))
    await userEvent.click(await screen.findByRole('tab', { name: 'Архів' }))

    const restore = await screen.findByRole('button', { name: 'Відновити' })

    expect(mockApiRequest).toHaveBeenCalledWith('/me/library?archived=true', expect.anything())
    expect(screen.queryByRole('button', { name: 'Архівувати' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Редагувати' })).not.toBeInTheDocument()

    await userEvent.click(restore)

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library/copy-9/restore',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})

describe('вхід із результатів додавання (docs/plan/fast-book-add.md, §2.2)', () => {
  it('?view=archive відкриває архів, де працює наявне відновлення', async () => {
    searchParams = new URLSearchParams('view=archive')
    mockApiRequest.mockResolvedValue({ groups: [] })

    render(withQueryClient(<LibraryScreen />))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith('/me/library?archived=true', expect.anything())
    })
    expect(screen.getByRole('tab', { name: 'Архів' })).toHaveAttribute('aria-selected', 'true')
  })

  it('«Додати книжку» веде в єдиний вхід додавання', async () => {
    mockApiRequest.mockResolvedValue({ groups: [] })

    render(withQueryClient(<LibraryScreen />))

    expect(await screen.findByRole('link', { name: 'Додати книжку' })).toHaveAttribute(
      'href',
      '/catalog/new',
    )
  })
})
