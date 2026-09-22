/** @jest-environment jsdom */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { LibraryResponse } from '@bookswap/shared'
import { useOwnLibrary } from '@/app/lib/use-library'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { CsvImportDraft } from '../components/CsvImportDraft'
import { buildDraft, buildRow } from '../library-import.test-helpers'

/**
 * Stage 8g (R12): after a commit, is the library actually up to date?
 *
 * The plan is explicit that navigation alone does not prove it, so this file
 * proves the two halves separately. First: the committed screen sends the owner
 * to `/library`, and a `useOwnLibrary` mounted there reads from the server
 * rather than from anything left over. Second — and this is the half R12 warns
 * about — a legacy resource that is ALREADY mounted does not learn about the
 * commit on its own, and `reload()` is what moves it.
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

function libraryWith(titles: readonly string[]): LibraryResponse {
  return {
    groups: titles.map((title, index) => ({
      work: {
        id: `work-${String(index)}`,
        title,
        origLang: 'en',
        firstPubYear: null,
        authors: [{ id: `author-${String(index)}`, name: 'Автор', role: 'AUTHOR' }],
        ratingAvg: 0,
        ratingCount: 0,
      },
      edition: {
        id: `edition-${String(index)}`,
        workId: `work-${String(index)}`,
        translationId: null,
        publisher: null,
        year: null,
        isbn13: null,
        pageCount: null,
        coverUrl: null,
        format: 'PAPERBACK',
        translation: null,
      },
      copies: [
        {
          id: `copy-${String(index)}`,
          status: 'AVAILABLE',
          visibility: 'FRIENDS',
          condition: 'GOOD',
          note: null,
          acquiredAt: null,
          currentHolder: null,
        },
      ],
    })),
  } as unknown as LibraryResponse
}

/** The smallest real consumer of the legacy hook — the same one `/library` uses. */
function OwnLibrary() {
  const { state, reload } = useOwnLibrary('own', {})

  return (
    <div>
      {state.status === 'ready' && (
        <ul>
          {state.data.groups.map((group) => (
            <li key={group.work.id}>{group.work.title}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => {
          void reload()
        }}
      >
        Оновити
      </button>
    </div>
  )
}

/** What `/me/activation` answers for the checklist the committed screen shows. */
const ACTIVATION_PROGRESS = {
  ownedCopyCount: 3,
  target: 10,
  hasReachedTarget: false,
  nextAction: 'ADD_BOOKS',
} as const

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('після коміту бібліотека, відкрита наново, читає свіжі дані з сервера', async () => {
  const ready = buildDraft({
    rows: [buildRow({ rowNumber: 1, status: 'READY_CREATE_CHAIN', rowVersion: 'v1' })],
  })
  const committed = buildDraft({ rows: [], status: 'COMMITTED', createdCopyCount: 1 })

  mockApiRequest.mockImplementation((path: string) => {
    // The committed screen carries the activation checklist (Stage 8h-2), and
    // it reads through this same mocked transport.
    if (String(path) === '/me/activation') return Promise.resolve(ACTIVATION_PROGRESS)

    return Promise.resolve(String(path).includes('/commit') ? committed : ready)
  })

  const queryClient = createTestQueryClient()

  render(withQueryClient(<CsvImportDraft importId="import-1" />, queryClient))

  await userEvent.click(await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' }))
  await screen.findByText(/Цей імпорт уже завершено/)

  // The route the owner is sent to.
  expect(screen.getByRole('link', { name: 'Моя бібліотека' })).toHaveAttribute('href', '/library')

  // Arriving there mounts the legacy resource, which fetches — the book the
  // commit created is on screen because the server was asked, not because
  // anything was carried over from the import.
  mockApiRequest.mockReset()
  mockApiRequest.mockResolvedValue(libraryWith(['Щойно імпортована книга']))

  render(<OwnLibrary />)

  expect(await screen.findByText('Щойно імпортована книга')).toBeInTheDocument()
  expect(mockApiRequest).toHaveBeenCalledWith('/me/library', expect.anything())
})

it('уже змонтований legacy-читач не оновлюється сам — його рухає лише явний reload', async () => {
  mockApiRequest.mockResolvedValue(libraryWith(['Стара книга']))

  render(<OwnLibrary />)

  expect(await screen.findByText('Стара книга')).toBeInTheDocument()

  const callsAfterMount = mockApiRequest.mock.calls.length

  // A commit happens elsewhere. R12: this hook shares no cache with TanStack
  // Query, so nothing about it can reach here — and it does not poll.
  mockApiRequest.mockResolvedValue(libraryWith(['Стара книга', 'Щойно імпортована книга']))

  await act(async () => {
    await Promise.resolve()
  })

  expect(mockApiRequest).toHaveBeenCalledTimes(callsAfterMount)
  expect(screen.queryByText('Щойно імпортована книга')).not.toBeInTheDocument()

  // The explicit reload is the whole mechanism for an already-mounted reader.
  await userEvent.click(screen.getByRole('button', { name: 'Оновити' }))

  expect(await screen.findByText('Щойно імпортована книга')).toBeInTheDocument()
})
