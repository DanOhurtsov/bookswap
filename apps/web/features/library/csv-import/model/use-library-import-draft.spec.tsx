/** @jest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ReactNode } from 'react'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { createTestQueryClient } from '@/app/lib/test-query-client'
import { buildDraft, buildRow } from '../library-import.test-helpers'
import { useLibraryImportDraft } from './use-library-import-draft'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: sessionState,
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let sessionState: { status: string; user?: { id: string } } = {
  status: 'authenticated',
  user: { id: 'user-1' },
}

const firstDraft = buildDraft({
  rows: [buildRow({ rowNumber: 1, status: 'NEEDS_REVIEW', rowVersion: 'v1' })],
})

const secondDraft = buildDraft({
  rows: [buildRow({ rowNumber: 1, status: 'SKIPPED', rowVersion: 'v2' })],
})

function Probe({ importId }: { importId: string }): ReactNode {
  const state = useLibraryImportDraft(importId)

  return (
    <div>
      <p data-testid="status">{state.draft?.rows[0]?.status ?? 'none'}</p>
      <p data-testid="version">{state.draft?.rows[0]?.rowVersion ?? 'none'}</p>
      <p data-testid="failure">{state.actionFailure?.kind ?? 'none'}</p>
      <p data-testid="skipped">{state.draft?.counts.skipped ?? -1}</p>
      <button
        type="button"
        onClick={() => {
          state.runRowAction({
            rowNumber: 1,
            request: { action: 'SKIP', expectedRowVersion: 'v1' },
          })
        }}
      >
        skip
      </button>
      <button
        type="button"
        onClick={() => {
          // Two calls inside ONE handler — the same render batch.
          state.runRowAction({
            rowNumber: 1,
            request: { action: 'SKIP', expectedRowVersion: 'v1' },
          })
          state.runRowAction({
            rowNumber: 1,
            request: { action: 'SKIP', expectedRowVersion: 'v1' },
          })
        }}
      >
        double
      </button>
    </div>
  )
}

/**
 * One `QueryClient` for the whole render, including rerenders — a fresh one per
 * rerender would empty the cache and make the staleness tests below pass for
 * the wrong reason.
 */
function renderProbe(importId = 'import-1') {
  const client = createTestQueryClient()
  const view = render(withQueryClient(<Probe importId={importId} />, client))

  return {
    ...view,
    show: (nextImportId: string) => {
      view.rerender(withQueryClient(<Probe importId={nextImportId} />, client))
    },
  }
}

beforeEach(() => {
  mockApiRequest.mockReset()
  sessionState = { status: 'authenticated', user: { id: 'user-1' } }
})

it('reads the draft from the one canonical query and shows its rows', async () => {
  mockApiRequest.mockResolvedValue(firstDraft)

  renderProbe()

  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })
  expect(mockApiRequest).toHaveBeenCalledTimes(1)
  expect(mockApiRequest).toHaveBeenCalledWith(
    '/me/library/imports/import-1',
    expect.objectContaining({ schema: expect.anything() }),
  )
})

it('replaces the whole cached draft with the PATCH response, counts included', async () => {
  mockApiRequest.mockResolvedValueOnce(firstDraft).mockResolvedValueOnce(secondDraft)

  renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })

  act(() => {
    screen.getByRole('button', { name: 'skip' }).click()
  })

  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('SKIPPED')
  })
  // Not just the one row: the recomputed counts arrive from the same response.
  expect(screen.getByTestId('skipped')).toHaveTextContent('1')
  expect(screen.getByTestId('version')).toHaveTextContent('v2')
})

it('sends expectedRowVersion with the row action', async () => {
  mockApiRequest.mockResolvedValueOnce(firstDraft).mockResolvedValueOnce(secondDraft)

  renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })

  act(() => {
    screen.getByRole('button', { name: 'skip' }).click()
  })

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/1',
      expect.objectContaining({
        method: 'PATCH',
        body: { action: 'SKIP', expectedRowVersion: 'v1' },
      }),
    )
  })
})

it('turns two calls in one batch into a single PATCH', async () => {
  mockApiRequest.mockResolvedValueOnce(firstDraft).mockResolvedValue(secondDraft)

  renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })
  mockApiRequest.mockClear()

  act(() => {
    screen.getByRole('button', { name: 'double' }).click()
  })

  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('SKIPPED')
  })
  const patches = mockApiRequest.mock.calls.filter(([, options]) => options?.method === 'PATCH')
  expect(patches).toHaveLength(1)
})

it('re-reads the draft on 409 and never repeats the PATCH by itself', async () => {
  const conflict = new ApiRequestError(409, {
    code: 'IMPORT_ROW_CONFLICT',
    message: 'Рядок змінився',
  })

  mockApiRequest
    .mockResolvedValueOnce(firstDraft)
    .mockRejectedValueOnce(conflict)
    .mockResolvedValue(secondDraft)

  renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })
  mockApiRequest.mockClear()

  act(() => {
    screen.getByRole('button', { name: 'skip' }).click()
  })

  await waitFor(() => {
    expect(screen.getByTestId('failure')).toHaveTextContent('conflict')
  })
  // The draft is re-read…
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('SKIPPED')
  })
  // …but exactly one PATCH was ever sent.
  const patches = mockApiRequest.mock.calls.filter(([, options]) => options?.method === 'PATCH')
  expect(patches).toHaveLength(1)
})

/**
 * Routes by URL and method instead of by call order: a PATCH and a background
 * GET race each other here on purpose, and an order-based mock would be
 * answering whichever call happened to arrive first.
 */
function routeApi(handlers: {
  get: (path: string) => Promise<unknown>
  patch: () => Promise<unknown>
}): void {
  mockApiRequest.mockImplementation((path: string, options?: { method?: string }) =>
    options?.method === 'PATCH' ? handlers.patch() : handlers.get(path),
  )
}

it('drops a late PATCH answer that belonged to a previous session', async () => {
  let resolvePatch: ((value: unknown) => void) | undefined

  routeApi({
    get: () => Promise.resolve(firstDraft),
    patch: () =>
      new Promise((resolve) => {
        resolvePatch = resolve
      }),
  })

  const view = renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })

  act(() => {
    screen.getByRole('button', { name: 'skip' }).click()
  })
  await waitFor(() => {
    expect(resolvePatch).toBeDefined()
  })

  // Someone else logs in while the PATCH is still in flight.
  sessionState = { status: 'authenticated', user: { id: 'user-2' } }
  view.show('import-1')

  await act(async () => {
    resolvePatch?.(secondDraft)
    await Promise.resolve()
  })

  // The answer computed for the previous person is dropped, not written into
  // the cache the new one now reads.
  expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
})

it('drops a late PATCH answer after the view moved to another draft', async () => {
  const otherDraft = buildDraft({
    id: 'import-2',
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'INVALID',
        rowVersion: 'w1',
        withValues: false,
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
    ],
  })
  let resolvePatch: ((value: unknown) => void) | undefined

  routeApi({
    get: (path) => Promise.resolve(path.includes('import-2') ? otherDraft : firstDraft),
    patch: () =>
      new Promise((resolve) => {
        resolvePatch = resolve
      }),
  })

  const view = renderProbe()
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('NEEDS_REVIEW')
  })

  act(() => {
    screen.getByRole('button', { name: 'skip' }).click()
  })
  await waitFor(() => {
    expect(resolvePatch).toBeDefined()
  })

  view.show('import-2')
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent('INVALID')
  })

  await act(async () => {
    resolvePatch?.(secondDraft)
    await Promise.resolve()
  })

  // The first draft's answer does not overwrite the draft now on screen.
  expect(screen.getByTestId('status')).toHaveTextContent('INVALID')
})
