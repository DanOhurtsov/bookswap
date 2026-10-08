/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LIBRARY_LIMITS, type Me, type OwnBookResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { ownBookFixture } from '../own-book.test-helpers'
import { OwnBookScreen } from './OwnBookScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

jest.mock('@/app/lib/use-session', () => ({ useSession: jest.fn() }))

jest.mock('@/features/reading-status/index.client', () => ({
  ReadingStatusPanel: ({ workId }: { workId: string }) => <p>Панель статусу читання: {workId}</p>,
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')
const { useSession } = jest.requireMock<{ useSession: jest.Mock }>('@/app/lib/use-session')

const GET_PATH = '/me/library/copies/copy-1'
const PATCH_PATH = '/me/library/copy-1'

interface RequestOptions {
  method?: string
  body?: { note: string | null }
}

let stored: OwnBookResponse

/** A tiny in-memory server: a GET returns what the last PATCH stored. */
function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === PATCH_PATH && options.method === 'PATCH' && options.body !== undefined) {
      stored = { ...stored, copy: { ...stored.copy, note: options.body.note } }

      return Promise.resolve({ copy: stored.copy })
    }

    if (path === GET_PATH) return Promise.resolve(stored)

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function notFound(): ApiRequestError {
  return new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Примірника не знайдено' })
}

function unavailable(): ApiRequestError {
  return new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервіс недоступний' })
}

function calls(method: string): unknown[][] {
  return apiRequest.mock.calls.filter(
    ([, options]) => ((options as RequestOptions | undefined)?.method ?? 'GET') === method,
  )
}

function renderScreen() {
  return render(withQueryClient(<OwnBookScreen entryId="copy-1" />))
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  stored = ownBookFixture()
  serve()
  useSession.mockReturnValue({
    state: { status: 'authenticated', user: { id: 'owner-1' } as Me },
    reload: jest.fn(),
  })
})

describe('OwnBookScreen: the owner’s page of one copy', () => {
  it('shows the book, the copy, the private note and the reading status of the work', async () => {
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()
    expect(screen.getByText('Тарас Шевченко')).toBeInTheDocument()
    expect(screen.getByText('Вдома, вільна')).toBeInTheDocument()
    expect(screen.getByText(/Добрий стан/)).toBeInTheDocument()
    expect(screen.getByText('з автографом')).toBeInTheDocument()
    expect(screen.getByText('Нотатку бачите лише ви.')).toBeInTheDocument()
    // The status belongs to the work (one for every copy), so the panel is given the work's id.
    expect(screen.getByText('Панель статусу читання: work-1')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(GET_PATH, expect.anything())
  })

  it('links to the general page of the book and back to the library', async () => {
    renderScreen()

    expect(await screen.findByRole('link', { name: 'Загальна сторінка книги' })).toHaveAttribute(
      'href',
      '/works/work-1',
    )
    expect(screen.getByRole('link', { name: '← До моєї бібліотеки' })).toHaveAttribute(
      'href',
      '/library',
    )
  })

  it('says there is no note and offers to add one', async () => {
    stored = ownBookFixture({ note: null })
    renderScreen()

    expect(await screen.findByText('Нотатки немає.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати нотатку' })).toBeInTheDocument()
  })

  it('names who holds the copy when it is not at home', async () => {
    stored = ownBookFixture({
      isHome: false,
      status: 'LENT_OUT',
      holder: { id: 'friend-1', displayName: 'Марта', avatarUrl: null },
    })
    renderScreen()

    expect(await screen.findByText('Зараз у: Марта')).toBeInTheDocument()
  })
})

describe('OwnBookScreen: editing the note', () => {
  it('saves the changed note with PATCH, shows it at once and asks the server again', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))

    const box = screen.getByRole('textbox', { name: 'Нотатка' })

    expect(box).toHaveValue('з автографом')

    await user.clear(box)
    await user.type(box, 'обіцяла до Різдва')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Нотатку збережено.')).toBeInTheDocument()
    expect(screen.getByText('обіцяла до Різдва')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Нотатка' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(
      PATCH_PATH,
      expect.objectContaining({ method: 'PATCH', body: { note: 'обіцяла до Різдва' } }),
    )
    // The entry was invalidated: the page read the copy again after the write.
    await waitFor(() => {
      expect(calls('GET').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('clears the note when the box is emptied', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))
    await user.clear(screen.getByRole('textbox', { name: 'Нотатка' }))
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Нотатки немає.')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(
      PATCH_PATH,
      expect.objectContaining({ body: { note: null } }),
    )
  })

  it('refuses a note over the limit before any request, with the contract’s limit in the message', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))

    const box = screen.getByRole('textbox', { name: 'Нотатка' })

    await user.clear(box)
    await user.click(box)
    await user.paste('я'.repeat(LIBRARY_LIMITS.noteMax + 1))
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText(/Нотатка задовга: не більше 1000 символів/)).toBeInTheDocument()
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('keeps the form open with the draft and shows the error when the save fails', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))

    apiRequest.mockImplementation((_path: string, options: RequestOptions = {}) =>
      options.method === 'PATCH' ? Promise.reject(unavailable()) : Promise.resolve(stored),
    )

    const box = screen.getByRole('textbox', { name: 'Нотатка' })

    await user.clear(box)
    await user.type(box, 'нова нотатка')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервіс недоступний')
    expect(screen.getByRole('textbox', { name: 'Нотатка' })).toHaveValue('нова нотатка')
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled()
  })

  it('shows what was saved even when the refresh after the save fails', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))

    apiRequest.mockImplementation((_path: string, options: RequestOptions = {}) => {
      if (options.method === 'PATCH') {
        return Promise.resolve({ copy: { ...stored.copy, note: 'збережена' } })
      }

      return Promise.reject(unavailable())
    })

    const box = screen.getByRole('textbox', { name: 'Нотатка' })

    await user.clear(box)
    await user.type(box, 'збережена')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Нотатку збережено.')).toBeInTheDocument()
    expect(screen.getByText('збережена')).toBeInTheDocument()
  })

  it('drops the draft on cancel and sends nothing', async () => {
    const user = userEvent.setup()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Редагувати нотатку' }))
    await user.type(screen.getByRole('textbox', { name: 'Нотатка' }), ' додаток')
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(screen.getByText('з автографом')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Нотатка' })).not.toBeInTheDocument()
    expect(calls('PATCH')).toHaveLength(0)
  })
})

describe('OwnBookScreen: other states', () => {
  it('shows "not found" for a copy that is not the owner’s, without retrying or leaking data', async () => {
    apiRequest.mockImplementation(() => Promise.reject(notFound()))
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Книжку не знайдено' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'До моєї бібліотеки' })).toHaveAttribute(
      'href',
      '/library',
    )
    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('shows a load failure with a retry that asks again', async () => {
    const user = userEvent.setup()

    apiRequest.mockImplementationOnce(() => Promise.reject(unavailable()))
    renderScreen()

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервіс недоступний')

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('heading', { name: 'Кобзар' })).toBeInTheDocument()
  })

  it('sends a guest to the login page and asks for no copy', async () => {
    useSession.mockReturnValue({ state: { status: 'guest' }, reload: jest.fn() })
    renderScreen()

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('does not call a failed session check "signed out": it offers a retry and asks for nothing', async () => {
    const reload = jest.fn()

    useSession.mockReturnValue({ state: { status: 'error', message: 'Сесія недоступна' }, reload })
    renderScreen()

    expect(screen.getByRole('alert')).toHaveTextContent('Сесія недоступна')
    expect(mockReplace).not.toHaveBeenCalled()
    expect(apiRequest).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
