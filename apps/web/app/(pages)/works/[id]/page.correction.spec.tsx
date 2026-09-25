/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type {
  AuthorMatch,
  CatalogSearchResponse,
  Work,
  WorkAuthor,
  WorkDetailResponse,
  WorkHistoryResponse,
  WishlistResponse,
  WorkPatchResponse,
} from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import WorkPage from './page'

function lastOf<T>(items: readonly T[]): T {
  const item = items[items.length - 1]

  if (item === undefined) throw new Error('expected a non-empty list')

  return item
}

/**
 * First 8e-3 end-to-end scenario (`docs/plan/stage-8-inventory.md`, 8e-3 DoD):
 * open a Work, edit the title, save, see the new title WITHOUT a manual page
 * reload. `useWork` stays the sole reader of Work data (R12) — this exercises
 * the real hook, mocking only the transport.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'me', name: 'Тест', email: 't@example.com' } },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

const mockReplace = jest.fn()
let routeWorkId = 'work-1'

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: routeWorkId }),
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}))

const { apiRequest: mockApiRequest, apiRequestWithRedirect: mockApiRequestWithRedirect } =
  jest.requireMock<{ apiRequest: jest.Mock; apiRequestWithRedirect: jest.Mock }>('@/app/lib/api')

function work(title: string, revision = 1, id = 'work-1'): Work {
  return {
    id,
    title,
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision,
  }
}

const authors: WorkAuthor[] = [
  { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 },
]

function detail(title: string, revision = 1, id = 'work-1'): WorkDetailResponse {
  return {
    work: work(title, revision, id),
    authors,
    translations: [],
    editions: [],
    viewerCapabilities: { canEditWork: true, editableTranslationIds: [], editableEditionIds: [] },
  }
}

const emptyHistory: WorkHistoryResponse = { work: work('Кобзар'), authors, entries: [] }
const emptyWishlist: WishlistResponse = { items: [] }

function stubSideRequests(): void {
  mockApiRequest.mockImplementation((path: string) => {
    if (path.endsWith('/history')) return Promise.resolve(emptyHistory)
    if (path === '/me/wishlist') return Promise.resolve(emptyWishlist)

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  routeWorkId = 'work-1'
  stubSideRequests()
})

it('редагування назви: зберегти → нова назва видно без ручного перезавантаження', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect
    .mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })
    .mockResolvedValueOnce({ data: detail('Кобзар. Нове видання', 1), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар. Нове видання')

  mockApiRequest.mockImplementationOnce(
    (path: string, options?: { method?: string; body?: unknown }) => {
      expect(path).toBe('/works/work-1')
      expect(options?.method).toBe('PATCH')
      expect(options?.body).toMatchObject({ title: 'Кобзар. Нове видання', expectedRevision: 1 })

      return Promise.resolve<WorkPatchResponse>({ work: work('Кобзар. Нове видання', 2), authors })
    },
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  // The PATCH response is shown immediately — this does not wait on `reload()`.
  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })

  await user.click(screen.getByRole('button', { name: 'Закрити' }))

  // The rest of the page reflects the background `reload()`, not a manual refresh.
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Кобзар. Нове видання' })).toBeInTheDocument()
  })

  expect(mockApiRequestWithRedirect).toHaveBeenCalledTimes(2)
})

it('порожня назва: валідація зупиняє сабміт, PATCH не надсилається', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValue({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  expect(await screen.findByText('Не вказано назву')).toBeInTheDocument()
  expect(mockApiRequest).not.toHaveBeenCalledWith(
    '/works/work-1',
    expect.objectContaining({ method: 'PATCH' }),
  )
})

it('403: сервер лишається остаточною межею прав, форма показує помилку', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValue({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  mockApiRequest.mockImplementationOnce(() =>
    Promise.reject(
      new ApiRequestError(403, {
        code: 'CATALOG_EDIT_FORBIDDEN',
        message: 'Ви не можете редагувати цей твір',
      }),
    ),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  expect(await screen.findByText('Ви не можете редагувати цей твір')).toBeInTheDocument()
  // Заголовок лишається старим — збій не мав нічого підмінити.
  expect(screen.getByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()
})

it('409 CATALOG_REVISION_CONFLICT: показує свіжі дані, не втрачає ввід, не перезаписує мовчки', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Мій варіант назви')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.reject(
      new ApiRequestError(409, {
        code: 'CATALOG_REVISION_CONFLICT',
        message: 'Твір змінено раніше',
        details: { work: work('Чиясь інша назва', 2), authors },
      }),
    ),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  expect(await screen.findByText('Чиясь інша назва')).toBeInTheDocument()
  // Ввід користувача лишається в полі — конфлікт не стер і не замінив його.
  expect(screen.getByLabelText('Назва твору')).toHaveValue('Мій варіант назви')

  mockApiRequestWithRedirect.mockResolvedValueOnce({
    data: detail('Мій варіант назви', 3),
    redirected: false,
  })
  mockApiRequest.mockImplementationOnce(
    (_path: string, options?: { method?: string; body?: unknown }) => {
      expect(options?.body).toMatchObject({ expectedRevision: 2 })

      return Promise.resolve<WorkPatchResponse>({ work: work('Мій варіант назви', 3), authors })
    },
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти мої зміни поверх' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
})

it('помилка refresh після успішного PATCH не виглядає як невдале збереження і не повторює PATCH', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар. Нове видання')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<WorkPatchResponse>({ work: work('Кобзар. Нове видання', 2), authors }),
  )
  mockApiRequestWithRedirect.mockRejectedValueOnce(
    new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'мережа лягла' }),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  // Saved — the PATCH response's own value is shown regardless of the failed refresh.
  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })

  const refreshNotice = await screen.findByText(/Не вдалося оновити сторінку повністю/)

  // Reported as a soft `role="status"` notice, never as the form's `role="alert"` save error.
  expect(refreshNotice.closest('[role="status"]')).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()

  const patchCalls = mockApiRequest.mock.calls.filter(
    ([, options]) => (options as { method?: string } | undefined)?.method === 'PATCH',
  )

  expect(patchCalls).toHaveLength(1)
})

it('PATCH успішний, GET ще летить: закриття форми лишає нову назву на сторінці', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар. Нове видання')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<WorkPatchResponse>({ work: work('Кобзар. Нове видання', 2), authors }),
  )
  // The background GET never resolves within this test — the overlay is the
  // ONLY thing keeping the new title on screen until it eventually does.
  mockApiRequestWithRedirect.mockImplementationOnce(() => new Promise(() => {}))

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })

  await user.click(screen.getByRole('button', { name: 'Закрити' }))

  // The correction controller lives above the form (owned by the page), so
  // closing it does not lose the confirmed PATCH while its own refresh is
  // still pending.
  expect(screen.getByRole('heading', { name: 'Кобзар. Нове видання' })).toBeInTheDocument()
})

it('PATCH успішний, GET провалився: закриття форми лишає нову назву на сторінці', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар. Нове видання')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<WorkPatchResponse>({ work: work('Кобзар. Нове видання', 2), authors }),
  )
  mockApiRequestWithRedirect.mockRejectedValueOnce(
    new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'мережа лягла' }),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await screen.findByText(/Не вдалося оновити сторінку повністю/)

  await user.click(screen.getByRole('button', { name: 'Закрити' }))

  expect(screen.getByRole('heading', { name: 'Кобзар. Нове видання' })).toBeInTheDocument()
})

it('два послідовні збереження без закриття форми: правильний expectedRevision, без штучного 409', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect
    .mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })
    .mockResolvedValueOnce({ data: detail('Перша правка', 2), redirected: false })
    .mockResolvedValueOnce({ data: detail('Друга правка', 3), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Перша правка')

  mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
    expect(options?.body).toMatchObject({ title: 'Перша правка', expectedRevision: 1 })

    return Promise.resolve<WorkPatchResponse>({ work: work('Перша правка', 2), authors })
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })

  await user.clear(titleInput)
  await user.type(titleInput, 'Друга правка')

  // If `expectedRevision` had not been synced after the first save, this
  // would still carry `1` and the server would answer 409 — never mocked
  // here, so an artificial conflict would fail this assertion outright.
  mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
    expect(options?.body).toMatchObject({ title: 'Друга правка', expectedRevision: 2 })

    return Promise.resolve<WorkPatchResponse>({ work: work('Друга правка', 3), authors })
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Друга правка' })).toBeInTheDocument()
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('подвійний клік «Зберегти» під час pending: лише один PATCH-запит', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар. Нове видання')

  let resolvePatch: ((value: WorkPatchResponse) => void) | undefined

  mockApiRequest.mockImplementationOnce(
    () =>
      new Promise<WorkPatchResponse>((resolve) => {
        resolvePatch = resolve
      }),
  )

  const saveButton = screen.getByRole('button', { name: 'Зберегти' })

  await user.click(saveButton)
  // The button disables once pending — a second click lands on a disabled
  // button, and the hook's own guard refuses a second PATCH regardless.
  await user.click(screen.getByRole('button', { name: 'Зберігаю…' }))

  const patchCalls = mockApiRequest.mock.calls.filter(
    ([, options]) => (options as { method?: string } | undefined)?.method === 'PATCH',
  )

  expect(patchCalls).toHaveLength(1)

  resolvePatch?.({ work: work('Кобзар. Нове видання', 2), authors })
  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
})

it('створити автора → зберегти → змінити лише назву: authors не надсилається повторно', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect
    .mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })
    .mockResolvedValueOnce({
      data: {
        ...detail('Кобзар', 2),
        authors: [
          ...authors,
          { id: 'author-new-1', name: 'Новий Автор', nameLatin: null, role: 'AUTHOR', position: 1 },
        ],
      },
      redirected: false,
    })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))
  await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))

  const newAuthorNameInputs = screen.getAllByLabelText('Імʼя')

  await user.type(lastOf(newAuthorNameInputs), 'Новий Автор')

  mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
    expect(options?.body).toMatchObject({
      authors: [
        { authorId: 'author-1', role: 'AUTHOR' },
        { name: 'Новий Автор', role: 'AUTHOR' },
      ],
    })

    return Promise.resolve<WorkPatchResponse>({
      work: work('Кобзар', 2),
      authors: [
        ...authors,
        { id: 'author-new-1', name: 'Новий Автор', nameLatin: null, role: 'AUTHOR', position: 1 },
      ],
    })
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })

  // Now touch ONLY the title — the authors UI is left exactly as the server confirmed it.
  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар (виправлено)')

  mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
    const body = options?.body as { authors?: unknown; expectedRevision?: number }

    // No `authors` key at all — the second author is already saved and
    // must not be created again.
    expect(body.authors).toBeUndefined()
    expect(body.expectedRevision).toBe(2)

    return Promise.resolve<WorkPatchResponse>({
      work: work('Кобзар (виправлено)', 3),
      authors: [
        ...authors,
        { id: 'author-new-1', name: 'Новий Автор', nameLatin: null, role: 'AUTHOR', position: 1 },
      ],
    })
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Кобзар (виправлено)' })).toBeInTheDocument()
  })
})

it('WORK_MERGED: переадресовує на canonicalWorkId зі справжньої форми деталей помилки', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  mockApiRequest.mockImplementationOnce(() =>
    Promise.reject(
      new ApiRequestError(409, {
        code: 'WORK_MERGED',
        message: 'Твір злито у work-canonical',
        // Real shape from `workMergedConflict` (canonical-work.service.ts):
        // `canonicalWorkId`/`requestedWorkId` — NOT `workId`.
        details: { canonicalWorkId: 'work-canonical', requestedWorkId: 'work-1' },
      }),
    ),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(mockReplace).toHaveBeenCalledWith('/works/work-canonical')
  })
  expect(screen.getByRole('link', { name: 'перейти вручну' })).toHaveAttribute(
    'href',
    '/works/work-canonical',
  )
})

it('пошук автора: мережева помилка показує error/retry, а не «нікого не знайдено»', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))
  await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))

  const nameInputs = screen.getAllByLabelText('Імʼя')
  const newRowName = lastOf(nameInputs)

  await user.type(newRowName, 'Іван Франко')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.reject(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'мережа лягла' })),
  )

  const searchButtons = screen.getAllByRole('button', { name: 'Чи є такий уже в каталозі?' })

  await user.click(lastOf(searchButtons))

  expect(
    await screen.findByText(/Не вдалося перевірити наявних авторів: мережа лягла/),
  ).toBeInTheDocument()
  expect(screen.queryByText('Схожих авторів не знайшлося.')).not.toBeInTheDocument()

  const found: AuthorMatch = {
    id: 'author-existing',
    name: 'Іван Франко',
    nameLatin: null,
    workCount: 3,
  }

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<CatalogSearchResponse>({
      results: [],
      authorMatches: [found],
      page: 1,
      pageSize: 10,
      total: 0,
      hasMore: false,
    }),
  )

  await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

  expect(await screen.findByText('Іван Франко')).toBeInTheDocument()
})

it('вибір наявного автора з пошуку: PATCH несе authorId, без name/nameLatin', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))
  await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))

  const nameInputs = screen.getAllByLabelText('Імʼя')

  await user.type(lastOf(nameInputs), 'Іван Франко')

  const found: AuthorMatch = {
    id: 'author-existing',
    name: 'Іван Франко',
    nameLatin: null,
    workCount: 3,
  }

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<CatalogSearchResponse>({
      results: [],
      authorMatches: [found],
      page: 1,
      pageSize: 10,
      total: 0,
      hasMore: false,
    }),
  )

  const searchButtons = screen.getAllByRole('button', { name: 'Чи є такий уже в каталозі?' })

  await user.click(lastOf(searchButtons))

  await user.click(await screen.findByRole('button', { name: 'Це він/вона' }))

  mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
    const body = options?.body as { authors?: unknown }

    expect(body.authors).toMatchObject([
      { authorId: 'author-1', role: 'AUTHOR' },
      { authorId: 'author-existing', role: 'AUTHOR' },
    ])
    expect(body.authors).not.toMatchObject([{}, { name: expect.anything() }])

    return Promise.resolve<WorkPatchResponse>({
      work: work('Кобзар', 2),
      authors: [
        ...authors,
        {
          id: 'author-existing',
          name: 'Іван Франко',
          nameLatin: null,
          role: 'AUTHOR',
          position: 1,
        },
      ],
    })
  })

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
})

it('pending PATCH реально змінює заголовок ще до відповіді сервера (optimistic)', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Кобзар (редагується)')

  let resolvePatch: ((value: WorkPatchResponse) => void) | undefined

  mockApiRequest.mockImplementationOnce(
    () =>
      new Promise<WorkPatchResponse>((resolve) => {
        resolvePatch = resolve
      }),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  // The PATCH has not answered yet — the optimistic entity still carries the
  // SAME revision as before submission, so a naive "fresh.revision >=
  // overlay.revision" check (equal, since nothing server-side changed yet)
  // would wrongly treat this as "already caught up" and discard the guess.
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Кобзар (редагується)' })).toBeInTheDocument()
  })

  resolvePatch?.({ work: work('Кобзар (редагується)', 2), authors })

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
})

it('A з підтвердженим overlay → перехід на B з МЕНШОЮ revision показує B, не A', async () => {
  const user = userEvent.setup()
  const client = createTestQueryClient()

  mockApiRequestWithRedirect.mockResolvedValueOnce({
    data: detail('Книга А', 1, 'work-1'),
    redirected: false,
  })

  const { rerender } = render(withQueryClient(<WorkPage />, client))

  expect(await screen.findByRole('heading', { name: 'Книга А' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Книга А (нова)')

  mockApiRequest.mockImplementationOnce(() =>
    Promise.resolve<WorkPatchResponse>({ work: work('Книга А (нова)', 5, 'work-1'), authors }),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
  expect(screen.getByRole('heading', { name: 'Книга А (нова)' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Закрити' }))

  // A DIFFERENT book, with a genuinely LOWER revision than A's confirmed
  // overlay (5). Without binding the overlay to entity identity, "fresh.revision
  // (2) >= overlay.revision (5)" is false, and A's title would keep showing
  // under B's URL.
  mockApiRequestWithRedirect.mockResolvedValueOnce({
    data: detail('Книга Б', 2, 'work-2'),
    redirected: false,
  })
  routeWorkId = 'work-2'
  rerender(withQueryClient(<WorkPage />, client))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Книга Б' })).toBeInTheDocument()
  })
})

it('перехід A → B під час PATCH для A: пізня відповідь A не впливає на B', async () => {
  const user = userEvent.setup()
  const client = createTestQueryClient()

  mockApiRequestWithRedirect.mockResolvedValueOnce({
    data: detail('Книга А', 1, 'work-1'),
    redirected: false,
  })

  const { rerender } = render(withQueryClient(<WorkPage />, client))

  expect(await screen.findByRole('heading', { name: 'Книга А' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

  const titleInput = screen.getByLabelText('Назва твору')

  await user.clear(titleInput)
  await user.type(titleInput, 'Книга А (в польоті)')

  let resolvePatchA: ((value: WorkPatchResponse) => void) | undefined

  mockApiRequest.mockImplementationOnce(
    () =>
      new Promise<WorkPatchResponse>((resolve) => {
        resolvePatchA = resolve
      }),
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Книга А (в польоті)' })).toBeInTheDocument()
  })

  // Navigate away to a DIFFERENT book WHILE A's PATCH is still in flight.
  mockApiRequestWithRedirect.mockResolvedValueOnce({
    data: detail('Книга Б', 1, 'work-2'),
    redirected: false,
  })
  routeWorkId = 'work-2'
  rerender(withQueryClient(<WorkPage />, client))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Книга Б' })).toBeInTheDocument()
  })

  // A's PATCH finally answers — must not leak onto B's page.
  resolvePatchA?.({ work: work('Книга А (в польоті)', 2, 'work-1'), authors })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(screen.getByRole('heading', { name: 'Книга Б' })).toBeInTheDocument()
  expect(screen.queryByText('Книга А (в польоті)')).not.toBeInTheDocument()
})

it(
  'save → новіший GET → закрити/відкрити форму: наступний save бере АКТУАЛЬНУ revision, ' +
    'не повторно старий confirmed, і не надсилає authors повторно',
  async () => {
    const user = userEvent.setup()

    mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail('Кобзар'), redirected: false })

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

    const titleInput = screen.getByLabelText('Назва твору')

    await user.clear(titleInput)
    await user.type(titleInput, 'Кобзар (перша правка)')

    mockApiRequest.mockImplementationOnce(() =>
      Promise.resolve<WorkPatchResponse>({ work: work('Кобзар (перша правка)', 2), authors }),
    )
    // The reload after THIS save reveals revision 3 — as if someone else's
    // change also landed by the time our own refresh GET ran.
    mockApiRequestWithRedirect.mockResolvedValueOnce({
      data: detail('Кобзар (перша правка)', 3),
      redirected: false,
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Кобзар (перша правка)' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Закрити' }))
    await user.click(screen.getByRole('button', { name: 'Виправити метадані твору' }))

    // Reopened form — the SECOND save must not have been silently pinned
    // back to revision 2 by the stale `confirmed` from the first save.
    const reopenedTitleInput = screen.getByLabelText('Назва твору')

    await user.clear(reopenedTitleInput)
    await user.type(reopenedTitleInput, 'Кобзар (друга правка)')

    mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
      const body = options?.body as { expectedRevision?: number; authors?: unknown }

      expect(body.expectedRevision).toBe(3)
      // Authors were never touched in either form session — must not be resent.
      expect(body.authors).toBeUndefined()

      return Promise.resolve<WorkPatchResponse>({
        work: work('Кобзар (друга правка)', 4),
        authors,
      })
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Кобзар (друга правка)' })).toBeInTheDocument()
    })
  },
)
