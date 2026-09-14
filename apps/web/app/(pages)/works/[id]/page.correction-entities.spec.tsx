/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type {
  Edition,
  EditionPatchResponse,
  Translation,
  TranslationPatchResponse,
  Work,
  WorkAuthor,
  WorkDetailResponse,
  WorkHistoryResponse,
  WishlistResponse,
} from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import WorkPage from './page'

/**
 * Translation/Edition correction forms and R12's per-entity revision check:
 * a Translation or Edition PATCH must be verified against ITS OWN revision,
 * not `Work.revision` — Work's own revision does not move when only a
 * Translation or Edition is patched.
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

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'work-1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const { apiRequest: mockApiRequest, apiRequestWithRedirect: mockApiRequestWithRedirect } =
  jest.requireMock<{ apiRequest: jest.Mock; apiRequestWithRedirect: jest.Mock }>('@/app/lib/api')

function work(): Work {
  return {
    id: 'work-1',
    title: 'Кобзар',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 5,
  }
}

const authors: WorkAuthor[] = [
  { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 },
]

function translation(translator: string, revision = 1): Translation {
  return {
    id: 'translation-1',
    workId: 'work-1',
    translator,
    lang: 'en',
    sourceLang: 'uk',
    year: null,
    isAbridged: false,
    hasNotes: false,
    notes: null,
    editionCount: 1,
    revision,
  }
}

function edition(publisher: string, revision = 1): Edition {
  return {
    id: 'edition-1',
    workId: 'work-1',
    translationId: 'translation-1',
    publisher,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    lang: 'en',
    translator: 'John Weston',
    revision,
  }
}

function detail(): WorkDetailResponse {
  return {
    work: work(),
    authors,
    translations: [translation('John Weston')],
    editions: [edition('Dnipro')],
    viewerCapabilities: {
      canEditWork: false,
      editableTranslationIds: ['translation-1'],
      editableEditionIds: ['edition-1'],
    },
  }
}

const emptyHistory: WorkHistoryResponse = { work: work(), authors, entries: [] }
const emptyWishlist: WishlistResponse = { items: [] }

beforeEach(() => {
  jest.clearAllMocks()
  mockApiRequest.mockImplementation((path: string) => {
    if (path.endsWith('/history')) return Promise.resolve(emptyHistory)
    if (path === '/me/wishlist') return Promise.resolve(emptyWishlist)

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })
})

it('capabilities: Work без canEditWork не показує кнопку правки твору', async () => {
  mockApiRequestWithRedirect.mockResolvedValue({ data: detail(), redirected: false })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Виправити метадані твору' })).not.toBeInTheDocument()
})

it("переклад: зберегти → нове ім'я перекладача видно; звіряється revision перекладу, не Work", async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect
    .mockResolvedValueOnce({ data: detail(), redirected: false })
    .mockResolvedValueOnce({
      data: { ...detail(), translations: [translation('Jane Weston', 2)] },
      redirected: false,
    })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити переклад' }))

  const translatorInput = screen.getByLabelText('Перекладач')

  await user.clear(translatorInput)
  await user.type(translatorInput, 'Jane Weston')

  mockApiRequest.mockImplementationOnce(
    (path: string, options?: { method?: string; body?: unknown }) => {
      expect(path).toBe('/translations/translation-1')
      expect(options?.method).toBe('PATCH')
      // Work.revision (5) must never leak in here — this PATCH targets the
      // Translation's own revision (1).
      expect(options?.body).toMatchObject({ translator: 'Jane Weston', expectedRevision: 1 })

      return Promise.resolve<TranslationPatchResponse>({
        translation: translation('Jane Weston', 2),
      })
    },
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
  expect(await screen.findByText('Jane Weston')).toBeInTheDocument()
})

it('видання: зберегти → нове видавництво видно; звіряється revision видання, не Work', async () => {
  const user = userEvent.setup()

  mockApiRequestWithRedirect
    .mockResolvedValueOnce({ data: detail(), redirected: false })
    .mockResolvedValueOnce({
      data: { ...detail(), editions: [edition('Веселка', 2)] },
      redirected: false,
    })

  render(withQueryClient(<WorkPage />))

  expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Виправити видання' }))

  const publisherInput = screen.getByLabelText('Видавництво')

  await user.clear(publisherInput)
  await user.type(publisherInput, 'Веселка')

  mockApiRequest.mockImplementationOnce(
    (path: string, options?: { method?: string; body?: unknown }) => {
      expect(path).toBe('/editions/edition-1')
      expect(options?.method).toBe('PATCH')
      expect(options?.body).toMatchObject({ publisher: 'Веселка', expectedRevision: 1 })

      return Promise.resolve<EditionPatchResponse>({ edition: edition('Веселка', 2) })
    },
  )

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByText('Збережено.')).toBeInTheDocument()
  })
})

it(
  'переклад: save → новіший GET → закрити/відкрити форму: наступний save бере ' +
    'АКТУАЛЬНУ revision перекладу, не повторно старий confirmed',
  async () => {
    const user = userEvent.setup()

    mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail(), redirected: false })

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Виправити переклад' }))

    const translatorInput = screen.getByLabelText('Перекладач')

    await user.clear(translatorInput)
    await user.type(translatorInput, 'Jane Weston')

    mockApiRequest.mockImplementationOnce(() =>
      Promise.resolve<TranslationPatchResponse>({ translation: translation('Jane Weston', 2) }),
    )
    // The reload after THIS save reveals revision 3 — someone else's change
    // also landed by the time our own refresh GET ran.
    mockApiRequestWithRedirect.mockResolvedValueOnce({
      data: { ...detail(), translations: [translation('Jane Weston', 3)] },
      redirected: false,
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByText('Збережено.')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Закрити' }))
    await user.click(screen.getByRole('button', { name: 'Виправити переклад' }))

    const reopenedTranslatorInput = screen.getByLabelText('Перекладач')

    await user.clear(reopenedTranslatorInput)
    await user.type(reopenedTranslatorInput, 'Jane Weston II')

    mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
      const body = options?.body as { expectedRevision?: number }

      expect(body.expectedRevision).toBe(3)

      return Promise.resolve<TranslationPatchResponse>({
        translation: translation('Jane Weston II', 4),
      })
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByText('Jane Weston II')).toBeInTheDocument()
    })
  },
)

it(
  'видання: save → новіший GET → закрити/відкрити форму: наступний save бере ' +
    'АКТУАЛЬНУ revision видання, не повторно старий confirmed',
  async () => {
    const user = userEvent.setup()

    mockApiRequestWithRedirect.mockResolvedValueOnce({ data: detail(), redirected: false })

    render(withQueryClient(<WorkPage />))

    expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Виправити видання' }))

    const publisherInput = screen.getByLabelText('Видавництво')

    await user.clear(publisherInput)
    await user.type(publisherInput, 'Веселка')

    mockApiRequest.mockImplementationOnce(() =>
      Promise.resolve<EditionPatchResponse>({ edition: edition('Веселка', 2) }),
    )
    mockApiRequestWithRedirect.mockResolvedValueOnce({
      data: { ...detail(), editions: [edition('Веселка', 3)] },
      redirected: false,
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByText('Збережено.')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Закрити' }))
    await user.click(screen.getByRole('button', { name: 'Виправити видання' }))

    const reopenedPublisherInput = screen.getByLabelText('Видавництво')

    await user.clear(reopenedPublisherInput)
    await user.type(reopenedPublisherInput, 'Веселка ІІ')

    mockApiRequest.mockImplementationOnce((_path: string, options?: { body?: unknown }) => {
      const body = options?.body as { expectedRevision?: number }

      expect(body.expectedRevision).toBe(3)

      return Promise.resolve<EditionPatchResponse>({ edition: edition('Веселка ІІ', 4) })
    })

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByText('Збережено.')).toBeInTheDocument()
    })
  },
)
