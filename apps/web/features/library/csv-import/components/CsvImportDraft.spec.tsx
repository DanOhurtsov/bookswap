/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type {
  LibraryImportCsvCells,
  LibraryImportDraftResponse,
  LibraryImportRowError,
} from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { IMPORT_CATALOG_RETRY_LABEL } from '../model/import-labels'
import { SECOND_ISBN, VALID_ISBN, buildDraft, buildRow } from '../library-import.test-helpers'
import { CsvImportDraft } from './CsvImportDraft'

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

const mockReplace = jest.fn()
let searchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => searchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const AMBIGUOUS: LibraryImportRowError = {
  code: 'AMBIGUOUS_CATALOG_MATCH',
  candidates: [{ workId: 'work-7', title: 'Тінь гори', authors: ['Ґреґорі Робертс'] }],
}

function mixedDraft() {
  return buildDraft({
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'READY_EXISTING_EDITION',
        rowVersion: 'v1',
        cells: { title: 'Шантарам', quantity: '2' },
      }),
      buildRow({
        rowNumber: 2,
        status: 'NEEDS_REVIEW',
        rowVersion: 'v2',
        cells: { isbn13: SECOND_ISBN, title: 'Тінь гори' },
        errors: [AMBIGUOUS],
      }),
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3',
        withValues: false,
        cells: { isbn13: '123' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
      buildRow({
        rowNumber: 4,
        status: 'SKIPPED',
        rowVersion: 'v4',
        cells: { title: 'Пропущена' },
      }),
    ],
  })
}

function renderDraft(importId = 'import-1') {
  const client = createTestQueryClient()

  return {
    ...render(withQueryClient(<CsvImportDraft importId={importId} />, client)),
    /** A background refresh of the same cached document — the component stays mounted. */
    refreshInBackground: () => client.invalidateQueries({ queryKey: ['library-import', importId] }),
    /** What the canonical cache actually still holds — not just what is rendered. */
    cachedDraft: () => client.getQueryData(['library-import', importId]),
  }
}

/** A response the test hands out now and settles later. */
function deferredResponse<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

function rowCard(rowNumber: number): HTMLElement {
  return screen.getByText(`№${String(rowNumber)}`).closest('li') as HTMLElement
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
  mockReplace.mockReset()
  searchParams = new URLSearchParams()
})

it('names every status in words, not only by colour', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())

  renderDraft()

  expect(await screen.findByText('Готово — видання вже в каталозі')).toBeInTheDocument()
  expect(screen.getByText('Потребує уваги')).toBeInTheDocument()
  expect(screen.getByText('Помилка в даних')).toBeInTheDocument()
  expect(screen.getByText('Пропущено')).toBeInTheDocument()
})

it('shows the server counts and readiness instead of counting readiness itself', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())

  renderDraft()

  await screen.findByText('Готові рядки')
  expect(screen.getByRole('button', { name: /Потребують уваги \(2\)/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Готові \(1\)/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Пропущені \(1\)/ })).toBeInTheDocument()
  expect(screen.getByText(/Ще треба розібратися з рядками: 2/)).toBeInTheDocument()
})

it('commits the draft the user is looking at, and only once per click', async () => {
  const ready = buildDraft({
    rows: [buildRow({ rowNumber: 1, status: 'READY_EXISTING_EDITION', rowVersion: 'v1' })],
    draftVersion: 'b'.repeat(64),
  })
  const committed = buildDraft({ rows: [], status: 'COMMITTED', createdCopyCount: 3 })

  mockApiRequest.mockImplementation((path: string) => {
    // The committed screen carries the activation checklist (Stage 8h-2), and
    // it reads through this same mocked transport.
    if (String(path) === '/me/activation') return Promise.resolve(ACTIVATION_PROGRESS)

    return Promise.resolve(String(path).includes('/commit') ? committed : ready)
  })
  renderDraft()

  const commit = await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' })

  expect(commit).toBeEnabled()

  // Two clicks in one go: the synchronous gate must turn them into one request.
  await userEvent.click(commit)
  await userEvent.click(commit)

  const calls = mockApiRequest.mock.calls.filter(([path]) => String(path).includes('/commit'))

  expect(calls).toHaveLength(1)
  expect(calls[0]?.[0]).toBe('/me/library/imports/import-1/commit')
  // The version of the draft that was on screen — not a guess, not omitted.
  expect(calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: { expectedDraftVersion: 'b'.repeat(64) },
  })

  expect(await screen.findByText(/Цей імпорт уже завершено/)).toBeInTheDocument()
  expect(screen.getByText(/додано примірників — 3/)).toBeInTheDocument()
})

it('keeps the confirmed commit on screen when a later read actually fails', async () => {
  const ready = buildDraft({
    rows: [buildRow({ rowNumber: 1, status: 'READY_EXISTING_EDITION', rowVersion: 'v1' })],
  })
  const committed = buildDraft({ rows: [], status: 'COMMITTED', createdCopyCount: 2 })

  mockApiRequest.mockImplementation((path: string) => {
    // The committed screen carries the activation checklist (Stage 8h-2), and
    // it reads through this same mocked transport.
    if (String(path) === '/me/activation') return Promise.resolve(ACTIVATION_PROGRESS)

    return Promise.resolve(String(path).includes('/commit') ? committed : ready)
  })

  const { refreshInBackground, cachedDraft } = renderDraft()

  await userEvent.click(await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' }))
  await screen.findByText(/Цей імпорт уже завершено/)

  // Every later read of this import fails — and the read is actually made.
  // Swapping the mock without issuing a request would have proven nothing.
  mockApiRequest.mockReset()
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Мережа недоступна' }),
  )

  await act(async () => {
    await refreshInBackground()
  })

  expect(mockApiRequest).toHaveBeenCalledWith('/me/library/imports/import-1', expect.anything())
  expect(screen.getByText(/додано примірників — 2/)).toBeInTheDocument()
  expect(cachedDraft()).toMatchObject({ import: { status: 'COMMITTED', createdCopyCount: 2 } })
})

it('drops a GET that was already in flight when the commit was confirmed', async () => {
  const ready = buildDraft({
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'READY_EXISTING_EDITION',
        rowVersion: 'v1',
        cells: { note: 'приватна нотатка' },
      }),
    ],
  })
  const committed = buildDraft({ rows: [], status: 'COMMITTED', createdCopyCount: 2 })
  const staleGet = deferredResponse<LibraryImportDraftResponse>()
  const pendingCommit = deferredResponse<LibraryImportDraftResponse>()

  // First GET answers immediately so the draft renders; everything after is
  // driven by the test.
  mockApiRequest.mockResolvedValueOnce(ready)

  const { refreshInBackground, cachedDraft } = renderDraft()

  await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' })

  mockApiRequest.mockImplementation((path: string) => {
    // The committed screen carries the activation checklist (Stage 8h-2), and it
    // reads through this same mocked transport. Without its own branch the
    // checklist would be answered with `staleGet` — an import draft, which
    // `activationResponseSchema` would never let past in the browser.
    if (String(path) === '/me/activation') return Promise.resolve(ACTIVATION_PROGRESS)

    return String(path).includes('/commit') ? pendingCommit.promise : staleGet.promise
  })

  // The exact ordering from the report: a commit is in flight, a GET starts
  // while it is, the commit is confirmed, and only then does that GET answer —
  // with the draft as it looked BEFORE the commit landed on the server.
  await userEvent.click(screen.getByRole('button', { name: 'Імпортувати до бібліотеки' }))

  void refreshInBackground()
  await act(async () => {
    await Promise.resolve()
  })

  await act(async () => {
    pendingCommit.resolve(committed)
    await pendingCommit.promise
  })

  await screen.findByText(/Цей імпорт уже завершено/)

  await act(async () => {
    staleGet.resolve(ready)
    await staleGet.promise
  })

  const checklist = screen.getByRole('region', { name: 'Прогрес до перших 10 книжок' })
  expect(await within(checklist).findByRole('link', { name: 'Додати книжку' })).toHaveAttribute(
    'href',
    '/catalog/new',
  )

  // Neither in the DOM…
  expect(screen.getByText(/Цей імпорт уже завершено/)).toBeInTheDocument()
  expect(screen.queryByText('№1')).not.toBeInTheDocument()
  expect(screen.queryByText(/приватна нотатка/)).not.toBeInTheDocument()

  // …nor in the canonical cache, which a render guard alone would have left
  // holding the stale rows and their private note.
  expect(cachedDraft()).toMatchObject({ import: { status: 'COMMITTED', createdCopyCount: 2 } })
  expect(cachedDraft()).toMatchObject({ rows: [] })
})

it.each(['EDITION_APPEARED', 'WORK_MERGED'])(
  'explains a %s refusal and offers exactly the button it names',
  async (reason) => {
    const ready = buildDraft({
      rows: [buildRow({ rowNumber: 1, status: 'READY_CREATE_CHAIN', rowVersion: 'v1' })],
    })

    mockApiRequest.mockImplementation((path: string) =>
      String(path).includes('/commit')
        ? Promise.reject(
            new ApiRequestError(409, {
              code: 'IMPORT_NOT_READY',
              message: 'Чернетку імпорту не можна імпортувати',
              details: { reason, rowNumbers: [1] },
            }),
          )
        : Promise.resolve(ready),
    )
    renderDraft()

    await userEvent.click(await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' }))

    const alert = await screen.findByRole('alert')

    // The message names a button, so that button has to be on the row it names.
    expect(alert).toHaveTextContent(`кнопка «${IMPORT_CATALOG_RETRY_LABEL}»`)
    expect(
      within(rowCard(1)).getByRole('button', { name: IMPORT_CATALOG_RETRY_LABEL }),
    ).toBeInTheDocument()
    // Not a dead end: the draft is still there and still committable.
    expect(screen.getByRole('button', { name: 'Імпортувати до бібліотеки' })).toBeInTheDocument()
  },
)

it('says which rows disagree about one ISBN instead of enabling the button', async () => {
  const blocked = buildDraft({
    rows: [
      buildRow({ rowNumber: 1, status: 'READY_CREATE_CHAIN', rowVersion: 'v1' }),
      buildRow({ rowNumber: 2, status: 'READY_CREATE_CHAIN', rowVersion: 'v2' }),
    ],
    canCommit: false,
    blockers: [{ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: [1, 2] }],
  })

  mockApiRequest.mockResolvedValue(blocked)
  renderDraft()

  const commit = await screen.findByRole('button', { name: 'Імпортувати до бібліотеки' })

  expect(commit).toBeDisabled()
  expect(screen.getByText(/той самий ISBN по-різному \(рядки 1, 2\)/)).toBeInTheDocument()
  expect(
    mockApiRequest.mock.calls.filter(([path]) => String(path).includes('/commit')),
  ).toHaveLength(0)
})

it('filters to the rows that need attention', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Шантарам')

  await user.click(screen.getByRole('button', { name: /Потребують уваги/ }))

  expect(mockReplace).toHaveBeenCalledWith('/library/imports/import-1?rows=attention', {
    scroll: false,
  })
})

it('renders the filter chosen in the URL', async () => {
  searchParams = new URLSearchParams('rows=skipped')
  mockApiRequest.mockResolvedValue(mixedDraft())

  renderDraft()

  expect(await screen.findByText('Пропущена')).toBeInTheDocument()
  expect(screen.queryByText('Шантарам')).not.toBeInTheDocument()
})

it('skips a row with the version it was shown, and applies the whole returned draft', async () => {
  const after = buildDraft({
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'SKIPPED',
        rowVersion: 'v1-next',
        cells: { title: 'Шантарам', quantity: '2' },
      }),
      buildRow({
        rowNumber: 2,
        status: 'READY_CREATE_CHAIN',
        rowVersion: 'v2',
        cells: { isbn13: SECOND_ISBN, title: 'Тінь гори' },
      }),
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3',
        withValues: false,
        cells: { isbn13: '123' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
      buildRow({
        rowNumber: 4,
        status: 'SKIPPED',
        rowVersion: 'v4',
        cells: { title: 'Пропущена' },
      }),
    ],
  })

  mockApiRequest.mockResolvedValueOnce(mixedDraft()).mockResolvedValueOnce(after)
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Шантарам')

  await user.click(within(rowCard(1)).getByRole('button', { name: 'Пропустити' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/1',
      expect.objectContaining({ body: { action: 'SKIP', expectedRowVersion: 'v1' } }),
    )
  })
  // Row 2 changed too — a PATCH answers with the whole recomputed draft.
  await waitFor(() => {
    expect(within(rowCard(2)).getByText('Готово — буде створено в каталозі')).toBeInTheDocument()
  })
  expect(within(rowCard(1)).getByRole('button', { name: 'Повернути рядок' })).toBeInTheDocument()
})

it('restores a skipped row through the real API action', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Пропущена')

  await user.click(within(rowCard(4)).getByRole('button', { name: 'Повернути рядок' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/4',
      expect.objectContaining({ body: { action: 'RESTORE', expectedRowVersion: 'v4' } }),
    )
  })
})

it('offers RETRY only for a retryable lookup failure, and only as an explicit action', async () => {
  const retryable = buildDraft({
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'NEEDS_REVIEW',
        rowVersion: 'v1',
        errors: [{ code: 'LOOKUP_UNAVAILABLE', reason: 'TIMEOUT', retryable: true }],
      }),
      buildRow({
        rowNumber: 2,
        status: 'NEEDS_REVIEW',
        rowVersion: 'v2',
        errors: [{ code: 'LOOKUP_NOT_FOUND' }],
      }),
    ],
  })

  mockApiRequest.mockResolvedValue(retryable)
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/довідник не відповів вчасно/)

  expect(
    within(rowCard(2)).queryByRole('button', { name: 'Спробувати знайти ще раз' }),
  ).not.toBeInTheDocument()

  mockApiRequest.mockClear()
  await user.click(within(rowCard(1)).getByRole('button', { name: 'Спробувати знайти ще раз' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/1',
      expect.objectContaining({ body: { action: 'RETRY', expectedRowVersion: 'v1' } }),
    )
  })
  // One request per click — nothing loops on its own.
  expect(mockApiRequest).toHaveBeenCalledTimes(1)
})

it('sends only the cells the person actually changed', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Шантарам')

  await user.click(within(rowCard(3)).getByRole('button', { name: 'Виправити' }))
  const isbn = screen.getByLabelText('ISBN-13')

  await user.clear(isbn)
  await user.type(isbn, VALID_ISBN)
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/3',
      expect.objectContaining({
        body: { action: 'EDIT', expectedRowVersion: 'v3', cells: { isbn13: VALID_ISBN } },
      }),
    )
  })
})

it('chooses an offered work, and can ask for a new one instead', async () => {
  mockApiRequest.mockResolvedValue(mixedDraft())
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Тінь гори')

  await user.click(within(rowCard(2)).getByRole('button', { name: 'Обрати твір' }))
  await user.click(screen.getByRole('radio', { name: /Це інша книжка/ }))
  await user.click(screen.getByRole('button', { name: 'Підтвердити вибір' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/2',
      expect.objectContaining({
        body: { action: 'CHOOSE', expectedRowVersion: 'v2', workId: null },
      }),
    )
  })
})

it('keeps an open form on the version it was opened with, whatever a refresh brings', async () => {
  const moved = buildDraft({
    rows: [
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3-moved',
        withValues: false,
        cells: { isbn13: '456' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
    ],
  })
  const original = buildDraft({
    rows: [
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3',
        withValues: false,
        cells: { isbn13: '123' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
    ],
  })

  mockApiRequest.mockResolvedValueOnce(original).mockResolvedValue(moved)
  const user = userEvent.setup()

  const view = renderDraft()
  await screen.findByText('Помилка в даних')

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('ISBN-13'))
  await user.type(screen.getByLabelText('ISBN-13'), VALID_ISBN)

  // A background refresh lands while the form is open: the row on screen moves
  // to a new version, but the open form still means the state the person
  // started from.
  await act(async () => {
    await view.refreshInBackground()
  })
  await waitFor(() => {
    expect(screen.getByText(/ISBN 456/)).toBeInTheDocument()
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/3',
      expect.objectContaining({ body: expect.objectContaining({ expectedRowVersion: 'v3' }) }),
    )
  })
})

it('keeps the typed text after a 409 and re-applies only when asked', async () => {
  const conflict = new ApiRequestError(409, {
    code: 'IMPORT_ROW_CONFLICT',
    message: 'Рядок змінився',
  })
  const refreshed = buildDraft({
    rows: [
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3-new',
        withValues: false,
        cells: { isbn13: '123' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
    ],
  })
  const original = buildDraft({
    rows: [
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3',
        withValues: false,
        cells: { isbn13: '123' },
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
    ],
  })

  mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
    options?.method === 'PATCH'
      ? (patchAnswers.shift() ?? Promise.resolve(refreshed))
      : Promise.resolve(getAnswers.shift() ?? refreshed),
  )
  const getAnswers = [original]
  const patchAnswers = [Promise.reject(conflict)]

  patchAnswers[0]?.catch(() => undefined)
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText('Помилка в даних')

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('ISBN-13'))
  await user.type(screen.getByLabelText('ISBN-13'), VALID_ISBN)
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  expect(await screen.findByText(/змінився, поки ви його редагували/)).toBeInTheDocument()
  // Exactly one PATCH so far: nothing repeated itself.
  expect(
    mockApiRequest.mock.calls.filter(([, options]) => options?.method === 'PATCH'),
  ).toHaveLength(1)
  // And the typed value is still there.
  expect(screen.getByLabelText('ISBN-13')).toHaveValue(VALID_ISBN)

  await user.click(
    screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
  )

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/import-1/rows/3',
      expect.objectContaining({ body: expect.objectContaining({ expectedRowVersion: 'v3-new' }) }),
    )
  })
})

it('renders a private note and a formula-like cell as plain text', async () => {
  const dangerous = buildDraft({
    rows: [
      buildRow({
        rowNumber: 1,
        status: 'NEEDS_REVIEW',
        rowVersion: 'v1',
        cells: {
          title: '=SUM(1+1)',
          note: '<img src=x onerror="alert(1)">',
        },
        errors: [{ code: 'LOOKUP_NOT_FOUND' }],
      }),
    ],
  })

  mockApiRequest.mockResolvedValue(dangerous)

  renderDraft()

  expect(await screen.findByText('=SUM(1+1)')).toBeInTheDocument()
  expect(screen.getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument()
  expect(document.querySelector('img')).toBeNull()
})

it('offers to send the file again when the draft has expired', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(410, { code: 'IMPORT_EXPIRED', message: 'застаріла' }),
  )

  renderDraft()

  expect(await screen.findByText(/Чернетка застаріла/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Надіслати файл ще раз' })).toHaveAttribute(
    'href',
    '/library/imports',
  )
})

it('answers a foreign or missing draft with a 404 state', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Імпорт не знайдено' }),
  )

  renderDraft('import-unknown')

  expect(await screen.findByText(/Чернетку імпорту не знайдено/)).toBeInTheDocument()
})

it('sends the person to log in on 401', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Потрібен вхід' }),
  )

  renderDraft()

  expect(await screen.findByRole('link', { name: 'Увійти' })).toHaveAttribute('href', '/login')
})

it('offers a manual retry when the network is down', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Failed to fetch'))

  renderDraft()

  const retry = await screen.findByRole('button', { name: 'Спробувати ще раз' })

  mockApiRequest.mockResolvedValue(mixedDraft())
  await userEvent.setup().click(retry)

  expect(await screen.findByText('Шантарам')).toBeInTheDocument()
})

// --- Regression: baseline, intent and refresh failures ------------------------

/**
 * A row that only ever differs by its version and its cells — the shape these
 * regressions are about is "same row, moved on", not "different row".
 */
function editableRow(rowVersion: string, cells: Partial<LibraryImportCsvCells>) {
  return buildRow({
    rowNumber: 3,
    status: 'NEEDS_REVIEW',
    rowVersion,
    cells: { isbn13: VALID_ISBN, ...cells },
    errors: [{ code: 'LOOKUP_NOT_FOUND' }],
  })
}

function draftOf(rowVersion: string, cells: Partial<LibraryImportCsvCells>) {
  return buildDraft({ rows: [editableRow(rowVersion, cells)] })
}

/** Answers by method, so a PATCH and a GET racing each other stay distinguishable. */
function routeApi(handlers: { get: () => unknown; patch: () => unknown }): void {
  mockApiRequest.mockImplementation((_path: string, options?: { method?: string }) =>
    options?.method === 'PATCH' ? handlers.patch() : handlers.get(),
  )
}

function conflictError(): ApiRequestError {
  return new ApiRequestError(409, { code: 'IMPORT_ROW_CONFLICT', message: 'Рядок змінився' })
}

function patchBodies(): Record<string, unknown>[] {
  return mockApiRequest.mock.calls
    .filter(([, options]) => options?.method === 'PATCH')
    .map(([, options]) => (options as { body: Record<string, unknown> }).body)
}

it('adopts the new row version after its own confirmed save, without closing', async () => {
  const saved = draftOf('v3-saved', { title: 'Перша назва' })

  routeApi({
    get: () => Promise.resolve(draftOf('v3', {})),
    patch: () => Promise.resolve(saved),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.type(screen.getByLabelText('Назва'), 'Перша назва')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(1)
  })

  // The form stays open; a second save must target the version the first save
  // minted, not the one the form was opened on.
  await user.type(screen.getByLabelText('Видавництво'), 'Фоліо')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(2)
  })
  expect(patchBodies()[1]).toEqual({
    action: 'EDIT',
    expectedRowVersion: 'v3-saved',
    cells: { publisher: 'Фоліо' },
  })
  // And the text typed while the first PATCH was in flight is still there.
  expect(screen.getByLabelText('Назва')).toHaveValue('Перша назва')
})

it('does not let a foreign refresh move the baseline of an open form', async () => {
  let current = draftOf('v3', {})

  routeApi({ get: () => Promise.resolve(current), patch: () => Promise.resolve(current) })
  const user = userEvent.setup()

  const view = renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.type(screen.getByLabelText('Назва'), 'Моя назва')

  // Someone else's change arrives through an ordinary GET — not this form's save.
  current = draftOf('v3-foreign', { note: 'чужа нотатка' })
  await act(async () => {
    await view.refreshInBackground()
  })
  await waitFor(() => {
    expect(screen.getByText(/чужа нотатка/)).toBeInTheDocument()
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(1)
  })
  expect(patchBodies()[0]).toHaveProperty('expectedRowVersion', 'v3')
})

it('re-applies only the fields the person edited, never a foreign change', async () => {
  let getAnswer = draftOf('v3', { title: 'Стара назва', note: 'моя нотатка' })
  const patchAnswers: unknown[] = [Promise.reject(conflictError())]

  ;(patchAnswers[0] as Promise<unknown>).catch(() => undefined)
  routeApi({
    get: () => Promise.resolve(getAnswer),
    patch: () => patchAnswers.shift() ?? Promise.resolve(getAnswer),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'Нова назва')

  // Another tab changes the private note; this PATCH loses the race.
  getAnswer = draftOf('v3-new', { title: 'Стара назва', note: 'нотатка з іншої вкладки' })
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  expect(await screen.findByText(/змінився, поки ви його редагували/)).toBeInTheDocument()
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
    ).toBeEnabled()
  })

  await user.click(
    screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
  )

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(2)
  })
  const reapplied = patchBodies()[1]

  expect(reapplied).toHaveProperty('expectedRowVersion', 'v3-new')
  // The person edited the title and nothing else: the note they never touched
  // must not travel back as "their" change and undo the other tab's edit.
  expect(reapplied).toHaveProperty('cells', { title: 'Нова назва' })
})

it('keeps the open form when the refresh after a 409 fails, and retries only the GET', async () => {
  const original = draftOf('v3', { title: 'Стара назва' })
  const refreshed = draftOf('v3-new', { title: 'Стара назва' })
  const getAnswers: unknown[] = [original, new TypeError('Failed to fetch'), refreshed]
  const patchAnswers: unknown[] = [Promise.reject(conflictError())]

  ;(patchAnswers[0] as Promise<unknown>).catch(() => undefined)
  routeApi({
    get: () => {
      const next = getAnswers.shift() ?? refreshed

      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    patch: () => patchAnswers.shift() ?? Promise.resolve(refreshed),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'Нова назва')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  // The refresh that follows the 409 fails. The form must survive it.
  expect(await screen.findByText(/Не вдалося оновити чернетку/)).toBeInTheDocument()
  expect(screen.getByLabelText('Назва')).toHaveValue('Нова назва')
  // Nothing may claim to act on "the updated row" before that row has arrived.
  expect(
    screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
  ).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Оновити чернетку' }))

  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
    ).toBeEnabled()
  })
  expect(screen.getByLabelText('Назва')).toHaveValue('Нова назва')
  // Only the GET was repeated — the PATCH never was.
  expect(patchBodies()).toHaveLength(1)
})

it('hides the draft when authorization is lost, even though one was cached', async () => {
  const getAnswers: unknown[] = [
    draftOf('v3', { note: 'приватна нотатка' }),
    new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Потрібен вхід' }),
  ]

  routeApi({
    get: () => {
      const next = getAnswers.shift()

      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    patch: () => Promise.resolve(draftOf('v3', {})),
  })

  const view = renderDraft()
  expect(await screen.findByText(/приватна нотатка/)).toBeInTheDocument()

  await act(async () => {
    await view.refreshInBackground()
  })

  expect(await screen.findByRole('link', { name: 'Увійти' })).toBeInTheDocument()
  expect(screen.queryByText(/приватна нотатка/)).not.toBeInTheDocument()
})

// --- Regression: intent after a re-apply, and fatal PATCH failures ------------

it('does not resend a field it never edited after a successful re-apply', async () => {
  const opened = draftOf('v3', { title: 'A', note: 'OLD' })
  // The other tab's change, visible once the conflict is re-read.
  const foreign = draftOf('v3-new', { title: 'A', note: 'NEW' })
  // What the re-applied edit produces: my title over their note.
  const reapplied = draftOf('v3-saved', { title: 'B', note: 'NEW' })
  const getAnswers: unknown[] = [opened, foreign]
  const patchAnswers: unknown[] = [Promise.reject(conflictError()), Promise.resolve(reapplied)]

  ;(patchAnswers[0] as Promise<unknown>).catch(() => undefined)
  routeApi({
    get: () => Promise.resolve(getAnswers.shift() ?? reapplied),
    patch: () => patchAnswers.shift() ?? Promise.resolve(reapplied),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'B')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  expect(await screen.findByText(/змінився, поки ви його редагували/)).toBeInTheDocument()
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
    ).toBeEnabled()
  })

  await user.click(
    screen.getByRole('button', { name: 'Застосувати мої зміни до оновленого рядка' }),
  )

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(2)
  })
  expect(patchBodies()[1]).toEqual({
    action: 'EDIT',
    expectedRowVersion: 'v3-new',
    cells: { title: 'B' },
  })

  // The form stays open and the person now edits one more, unrelated field.
  await user.type(screen.getByLabelText('Видавництво'), 'Фоліо')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(3)
  })
  // Only the publisher. The note they never touched must not travel along as
  // `OLD` and undo the other tab's `NEW`.
  expect(patchBodies()[2]).toEqual({
    action: 'EDIT',
    expectedRowVersion: 'v3-saved',
    cells: { publisher: 'Фоліо' },
  })
  expect(screen.getByLabelText('Приватна нотатка')).toHaveValue('NEW')
})

it('keeps text typed while a PATCH was in flight, and still adopts the rest', async () => {
  const opened = draftOf('v3', { title: 'A', note: 'OLD' })
  const saved = draftOf('v3-saved', { title: 'B', note: 'SERVER' })
  let resolvePatch: ((value: unknown) => void) | undefined

  routeApi({
    get: () => Promise.resolve(opened),
    patch: () =>
      new Promise((resolve) => {
        resolvePatch = resolve
      }),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'B')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))
  await waitFor(() => {
    expect(resolvePatch).toBeDefined()
  })

  // Typed while the save was still in flight: unsent, and the user's.
  await user.type(screen.getByLabelText('Видавництво'), 'Фоліо')

  await act(async () => {
    resolvePatch?.(saved)
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(screen.getByLabelText('Приватна нотатка')).toHaveValue('SERVER')
  })
  expect(screen.getByLabelText('Видавництво')).toHaveValue('Фоліо')
})

it.each([
  ['401', new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Потрібен вхід' })],
  ['404', new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Імпорт не знайдено' })],
  [
    'IMPORT_EXPIRED',
    new ApiRequestError(410, { code: 'IMPORT_EXPIRED', message: 'Чернетка застаріла' }),
  ],
])('drops the cached draft when a row action answers %s', async (_label, error) => {
  routeApi({
    get: () => Promise.resolve(draftOf('v3', { note: 'приватна нотатка' })),
    patch: () => Promise.reject(error),
  })
  const user = userEvent.setup()

  const view = renderDraft()
  expect(await screen.findByText(/приватна нотатка/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Пропустити' }))

  await waitFor(() => {
    expect(screen.queryByText(/приватна нотатка/)).not.toBeInTheDocument()
  })
  // Not merely hidden: gone from the canonical cache as well.
  expect(view.cachedDraft()).toBeUndefined()
  // And recognised from the PATCH alone — no second GET was needed to believe it.
  expect(mockApiRequest.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(0)
})

it('does not let a late row action restore a draft that was already refused', async () => {
  let announceStart: (() => void) | undefined
  const patchStarted = new Promise<void>((resolve) => {
    announceStart = resolve
  })
  let resolvePatch: ((value: unknown) => void) | undefined
  const getAnswers: unknown[] = [
    draftOf('v3', { note: 'приватна нотатка' }),
    new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Потрібен вхід' }),
  ]

  routeApi({
    get: () => {
      const next = getAnswers.shift()

      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    // One real, genuinely pending PATCH — not a second request smuggled in to
    // dodge the one-at-a-time serialization.
    patch: () =>
      new Promise((resolve) => {
        resolvePatch = resolve
        announceStart?.()
      }),
  })
  const user = userEvent.setup()

  const view = renderDraft()
  expect(await screen.findByText(/приватна нотатка/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Пропустити' }))
  // Explicit signal, not a guess: the request is in flight from here on.
  await act(async () => {
    await patchStarted
  })
  expect(resolvePatch).toBeDefined()

  // The refusal arrives through the other legitimate channel while that PATCH
  // is still open — an ordinary background re-read of the draft.
  await act(async () => {
    await view.refreshInBackground()
  })
  await waitFor(() => {
    expect(screen.queryByText(/приватна нотатка/)).not.toBeInTheDocument()
  })
  expect(view.cachedDraft()).toBeUndefined()

  // Only now does the old PATCH come back — carrying a perfectly valid draft.
  await act(async () => {
    resolvePatch?.(draftOf('v3-late', { note: 'приватна нотатка' }))
    await Promise.resolve()
  })

  expect(view.cachedDraft()).toBeUndefined()
  expect(screen.queryByText(/приватна нотатка/)).not.toBeInTheDocument()
})

it('keeps a value typed back to its original while the PATCH was open', async () => {
  const opened = draftOf('v1', { title: 'A' })
  const saved = draftOf('v2', { title: 'B' })
  let announceStart: (() => void) | undefined
  const patchStarted = new Promise<void>((resolve) => {
    announceStart = resolve
  })
  let resolvePatch: ((value: unknown) => void) | undefined
  const patchAnswers: unknown[] = []

  routeApi({
    get: () => Promise.resolve(opened),
    patch: () =>
      patchAnswers.shift() ??
      new Promise((resolve) => {
        resolvePatch = resolve
        announceStart?.()
      }),
  })
  const user = userEvent.setup()

  renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'B')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))
  await act(async () => {
    await patchStarted
  })
  expect(resolvePatch).toBeDefined()

  // While the save is open, the person changes their mind and types the
  // ORIGINAL value back. Fields stay editable on purpose — locking the form
  // during a PATCH would trade this bug for a worse one.
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'A')

  patchAnswers.push(Promise.resolve(saved))
  await act(async () => {
    resolvePatch?.(saved)
    await Promise.resolve()
  })

  // `B` was confirmed, but `A` is newer than the save and was never sent.
  expect(screen.getByLabelText('Назва')).toHaveValue('A')

  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(2)
  })
  expect(patchBodies()[1]).toEqual({
    action: 'EDIT',
    expectedRowVersion: 'v2',
    cells: { title: 'A' },
  })
})

it('keeps the typed text when a row action fails with a network error', async () => {
  routeApi({
    get: () => Promise.resolve(draftOf('v3', { title: 'A', note: 'OLD' })),
    patch: () => Promise.reject(new TypeError('Failed to fetch')),
  })
  const user = userEvent.setup()

  const view = renderDraft()
  await screen.findByText(/Жоден довідник не знає/)

  await user.click(screen.getByRole('button', { name: 'Виправити' }))
  await user.clear(screen.getByLabelText('Назва'))
  await user.type(screen.getByLabelText('Назва'), 'B')
  await user.click(screen.getByRole('button', { name: 'Зберегти рядок' }))

  await waitFor(() => {
    expect(patchBodies()).toHaveLength(1)
  })
  expect(screen.getByLabelText('Назва')).toHaveValue('B')
  expect(view.cachedDraft()).toBeDefined()
})

/**
 * 8f-4 fix: a cell the reader refused renders as empty, so the generic
 * "invalid value" sentence would leave a person staring at a blank box with no
 * idea what to do. The row has to say what Excel put there.
 */
it('explains a refused cell by what was in it, not as a generic invalid value', async () => {
  const row = buildRow({
    rowNumber: 1,
    status: 'INVALID',
    rowVersion: 'v1',
    errors: [{ code: 'INVALID_FIELD', field: 'quantity' }],
  })

  mockApiRequest.mockResolvedValue(
    buildDraft({ rows: [{ ...row, rejectedCells: { quantity: 'UNEXPECTED_DATE' } }] }),
  )
  render(withQueryClient(<CsvImportDraft importId="import-1" />))

  expect(await screen.findByText(/Excel зберіг у цій клітинці дату/)).toBeInTheDocument()
  expect(screen.queryByText('Некоректне значення поля «Кількість примірників».')).toBeNull()
})
