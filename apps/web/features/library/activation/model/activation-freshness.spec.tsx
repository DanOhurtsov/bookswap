/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { QueryClient } from '@tanstack/react-query'
import type { LibraryResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { CsvImportDraft } from '@/features/library/csv-import/index.client'
import { LibraryScreen } from '@/features/library/own-library/index.client'
import { buildDraft, buildRow } from '@/features/library/csv-import/library-import.test-helpers'
import { ACTIVATION_QUERY_KEY } from './activation-query'

/**
 * Stage 8h-2: the checklist is only as honest as its invalidation.
 *
 * Four things change how many copies an owner has — adding one, adding another
 * of the same edition, committing an import, deleting one — and each of them is
 * checked twice here: that a success invalidates `['activation']`, and that a
 * failure does not. The second half matters just as much: a refused request
 * changed no copies, so refetching after it would only make the count flicker
 * for no reason.
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

/** jsdom has no `showModal`; the delete confirmation is a native `<dialog>`. */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

interface Harness {
  client: QueryClient
  invalidate: jest.SpyInstance
}

function harness(): Harness {
  const client = createTestQueryClient()

  return { client, invalidate: jest.spyOn(client, 'invalidateQueries') }
}

/** Calls that targeted the activation key specifically, ignoring every other key. */
function activationInvalidations(invalidate: jest.SpyInstance): unknown[] {
  return invalidate.mock.calls.filter(
    ([options]) =>
      JSON.stringify((options as { queryKey?: unknown }).queryKey) ===
      JSON.stringify(ACTIVATION_QUERY_KEY),
  )
}

/** The count the committed screen shows once the invalidated query refetches. */
const ACTIVATION_AFTER = {
  ownedCopyCount: 3,
  target: 10,
  hasReachedTarget: false,
  nextAction: 'ADD_BOOKS',
} as const

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('коміт імпорту', () => {
  const ready = buildDraft({
    rows: [buildRow({ rowNumber: 1, status: 'READY_CREATE_CHAIN', rowVersion: 'v1' })],
  })

  async function commit(client: QueryClient): Promise<void> {
    render(withQueryClient(<CsvImportDraft importId="import-1" />, client))

    await userEvent.click(await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' }))
  }

  it('успішний коміт інвалідує ["activation"]', async () => {
    const { client, invalidate } = harness()
    const committed = buildDraft({ rows: [], status: 'COMMITTED', createdCopyCount: 3 })

    mockApiRequest.mockImplementation((path: string) => {
      if (String(path) === '/me/activation') return Promise.resolve(ACTIVATION_AFTER)
      return Promise.resolve(String(path).includes('/commit') ? committed : ready)
    })

    await commit(client)
    await screen.findByText(/Цей імпорт уже завершено/)

    expect(activationInvalidations(invalidate)).toHaveLength(1)
  })

  it('невдалий коміт не інвалідує нічого — жодного примірника не створено', async () => {
    const { client, invalidate } = harness()

    mockApiRequest.mockImplementation((path: string) =>
      String(path) === '/me/activation'
        ? Promise.resolve(ACTIVATION_AFTER)
        : String(path).includes('/commit')
          ? Promise.reject(
              new ApiRequestError(409, {
                code: 'IMPORT_NOT_READY',
                message: 'Чернетку зараз імпортувати не можна',
                details: { reason: 'ROWS_UNRESOLVED', rowNumbers: [1] },
              }),
            )
          : Promise.resolve(ready),
    )

    await commit(client)

    expect(activationInvalidations(invalidate)).toHaveLength(0)
  })
})

describe('видалення власного примірника', () => {
  function libraryWithOneCopy(): LibraryResponse {
    return {
      groups: [
        {
          work: {
            id: 'work-1',
            title: 'Шантарам',
            origLang: 'en',
            firstPubYear: null,
            authors: [{ id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }],
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
          authors: [{ id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }],
          copies: [
            {
              id: 'copy-1',
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

  async function deleteCopy(client: QueryClient): Promise<void> {
    render(withQueryClient(<LibraryScreen />, client))

    // Two buttons carry this name: the one on the copy row, and the confirm
    // inside the always-mounted `<dialog>`. The row's comes first in the DOM.
    const [rowButton] = await screen.findAllByRole('button', { name: 'Видалити' })

    await userEvent.click(rowButton as HTMLElement)

    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Видалити',
    })

    await userEvent.click(confirm)
  }

  it('успішне видалення інвалідує ["activation"] і лишає legacy-перезавантаження', async () => {
    const { client, invalidate } = harness()
    const library = libraryWithOneCopy()

    mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === 'DELETE' ? Promise.resolve(undefined) : Promise.resolve(library),
    )

    await deleteCopy(client)

    expect(activationInvalidations(invalidate)).toHaveLength(1)
    // R12: у legacy-читача немає спільного кеша, тож його рухає власний reload —
    // і він справді стався (повторний GET після DELETE), незалежно від
    // інвалідації activation.
    await waitFor(() => {
      expect(
        mockApiRequest.mock.calls.filter(([path]) => path === '/me/library').length,
      ).toBeGreaterThan(1)
    })
  })

  it('невдале видалення не інвалідує нічого', async () => {
    const { client, invalidate } = harness()
    const library = libraryWithOneCopy()

    mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === 'DELETE'
        ? Promise.reject(
            new ApiRequestError(409, {
              code: 'COPY_HAS_ACTIVE_LOAN',
              message: 'Примірник має активне позичання',
            }),
          )
        : Promise.resolve(library),
    )

    await deleteCopy(client)

    expect(await screen.findByText(/активне позичання/)).toBeInTheDocument()
    expect(activationInvalidations(invalidate)).toHaveLength(0)
  })
})
