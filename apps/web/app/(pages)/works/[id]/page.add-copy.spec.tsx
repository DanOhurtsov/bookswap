/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Edition, Visibility, WorkDetailResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { chooseOption } from '@/components/Form/test-choose-option'
import WorkPage from './page'

/**
 * BS-79: «Це моє видання» → `POST /me/library`. Кожне відкриття форми починає «Кому показувати» з
 * видимості бібліотеки поточного користувача (невідоме → FRIENDS); поки форма відкрита, оновлення профілю
 * вибору не скидає; вибір надсилається явно й профілю не змінює.
 */

jest.mock('@/features/network/index.client', () => ({ HoldersPanel: () => null }))
jest.mock('@/features/reading-status/index.client', () => ({ ReadingStatusPanel: () => null }))

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

type MockSession = {
  status: 'authenticated'
  user: { id: string; displayName: string; email: string; libraryVisibility?: unknown }
}

function sessionOf(libraryVisibility: unknown, id = 'me'): MockSession {
  return {
    status: 'authenticated',
    user: { id, displayName: 'Тест', email: `${id}@example.com`, libraryVisibility },
  }
}

let mockSession: MockSession = sessionOf('FRIENDS')
const mockSessionListeners = new Set<() => void>()

function setSession(next: MockSession): void {
  act(() => {
    mockSession = next
    mockSessionListeners.forEach((listener) => {
      listener()
    })
  })
}

jest.mock('@/app/lib/use-session', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react')

  return {
    useSession: () => ({
      state: useSyncExternalStore(
        (listener) => {
          mockSessionListeners.add(listener)

          return () => {
            mockSessionListeners.delete(listener)
          }
        },
        () => mockSession,
        () => mockSession,
      ),
      reload: jest.fn(),
      setUser: jest.fn(),
    }),
  }
})

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'work-1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const { apiRequest: mockApiRequest, apiRequestWithRedirect: mockApiRequestWithRedirect } =
  jest.requireMock<{ apiRequest: jest.Mock; apiRequestWithRedirect: jest.Mock }>('@/app/lib/api')

const LABELS: Readonly<Record<Visibility, string>> = {
  PUBLIC: 'Публічно — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватно — тільки я',
}

const WORK = {
  id: 'work-1',
  title: 'Кобзар',
  origLang: 'uk',
  firstPubYear: null,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

const EDITION: Edition = {
  id: 'e-1',
  workId: 'work-1',
  translationId: null,
  textKind: 'ORIGINAL',
  publisher: 'Наука',
  year: 2019,
  isbn13: '9783161484100',
  pageCount: 320,
  coverUrl: null,
  format: 'HARDCOVER',
  lang: 'uk',
  translator: null,
  revision: 1,
}

const DETAIL: WorkDetailResponse = {
  work: WORK,
  authors: [],
  translations: [],
  editions: [EDITION],
}

type AddCopyBody = { editionId: string; visibility: Visibility }

let addCopyHandler: (body: AddCopyBody) => Promise<unknown>

function addCopyCalls(): AddCopyBody[] {
  return mockApiRequest.mock.calls
    .filter(([path]) => path === '/me/library')
    .map(([, options]) => (options as { body: AddCopyBody }).body)
}

/** Every write the page sent: the add, and never a profile change. */
function writes(): string[] {
  return mockApiRequest.mock.calls
    .map(([path, options]) => ({
      path: String(path),
      method: (options as { method?: string } | undefined)?.method ?? 'GET',
    }))
    .filter(({ method }) => method !== 'GET')
    .map(({ path, method }) => `${method} ${path}`)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSession = sessionOf('FRIENDS')
  addCopyHandler = () => Promise.resolve({ copy: { id: 'copy-1' } })
  mockApiRequestWithRedirect.mockResolvedValue({ data: DETAIL, redirected: false })
  mockApiRequest.mockImplementation((path: string, options?: { body?: unknown }) => {
    if (path === '/me/library') return addCopyHandler(options?.body as AddCopyBody)
    if (path.startsWith('/works/')) return Promise.resolve({ work: WORK, authors: [], entries: [] })

    return Promise.resolve({ items: [] })
  })
})

type User = ReturnType<typeof userEvent.setup>

async function openForm(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
}

function visibilityField(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Кому показувати' })
}

async function submit(user: User): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Додати примірник' }))
}

describe('«Це моє видання»: видимість нового примірника (BS-79)', () => {
  it.each<Visibility>(['PUBLIC', 'FRIENDS', 'PRIVATE'])(
    'профіль %s → форма починає з нього й надсилає його явно',
    async (visibility) => {
      mockSession = sessionOf(visibility)

      const user = userEvent.setup()

      render(withQueryClient(<WorkPage />))
      await openForm(user)

      expect(visibilityField()).toHaveTextContent(LABELS[visibility])

      await submit(user)
      await screen.findByText('Примірник додано до вашої бібліотеки.')

      expect(addCopyCalls()).toEqual([expect.objectContaining({ editionId: 'e-1', visibility })])
    },
  )

  it.each([undefined, 'SECRET'])('відсутнє чи невалідне значення (%p) → FRIENDS', async (value) => {
    mockSession = sessionOf(value)

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)

    expect(visibilityField()).toHaveTextContent(LABELS.FRIENDS)
  })

  it('вибір людини надсилається замість профілю; профіль не змінюється', async () => {
    mockSession = sessionOf('PUBLIC')

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)
    await chooseOption(user, 'Кому показувати', LABELS.PRIVATE)
    await submit(user)
    await screen.findByText('Примірник додано до вашої бібліотеки.')

    expect(addCopyCalls()[0]?.visibility).toBe('PRIVATE')
    expect(writes()).toEqual(['POST /me/library'])
  })

  it('оновлення профілю, поки форма відкрита, не скидає вибору; нове відкриття читає новий профіль', async () => {
    mockSession = sessionOf('PUBLIC')

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)

    setSession(sessionOf('PRIVATE'))
    expect(visibilityField()).toHaveTextContent(LABELS.PUBLIC)

    await chooseOption(user, 'Кому показувати', LABELS.FRIENDS)
    setSession(sessionOf('PUBLIC'))
    expect(visibilityField()).toHaveTextContent(LABELS.FRIENDS)

    await submit(user)
    await screen.findByText('Примірник додано до вашої бібліотеки.')
    expect(addCopyCalls()[0]?.visibility).toBe('FRIENDS')

    setSession(sessionOf('PRIVATE'))
    await openForm(user)

    expect(visibilityField()).toHaveTextContent(LABELS.PRIVATE)
  })

  it('відмова сервера лишає вибір; повтор надсилає його ж', async () => {
    let attempt = 0

    addCopyHandler = () => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Немає видання' }))
        : Promise.resolve({ copy: { id: 'copy-1' } })
    }

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)
    await chooseOption(user, 'Кому показувати', LABELS.PRIVATE)
    await submit(user)

    expect(await screen.findByText('Немає видання')).toBeInTheDocument()
    expect(visibilityField()).toHaveTextContent(LABELS.PRIVATE)

    await submit(user)
    await screen.findByText('Примірник додано до вашої бібліотеки.')

    expect(addCopyCalls().map((body) => body.visibility)).toEqual(['PRIVATE', 'PRIVATE'])
  })

  it('поки запит у польоті, вибір заблоковано', async () => {
    addCopyHandler = () => new Promise(() => undefined)

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)
    await submit(user)

    await waitFor(() => {
      expect(visibilityField()).toBeDisabled()
    })
  })

  it('інший акаунт не бачить чужої чернетки', async () => {
    mockSession = sessionOf('FRIENDS', 'alice')

    const user = userEvent.setup()

    render(withQueryClient(<WorkPage />))
    await openForm(user)
    await chooseOption(user, 'Кому показувати', LABELS.PRIVATE)

    setSession(sessionOf('PUBLIC', 'bob'))

    const editions = (await screen.findByRole('heading', { name: 'Видання' })).closest('section')

    // The card is a new one for the new viewer: its form is closed, and opening it reads bob's profile.
    expect(within(editions as HTMLElement).queryByRole('combobox')).toBeNull()
    await openForm(user)
    expect(visibilityField()).toHaveTextContent(LABELS.PUBLIC)
  })
})
