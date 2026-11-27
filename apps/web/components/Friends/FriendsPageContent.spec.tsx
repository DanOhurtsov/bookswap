/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Friend, FriendRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { FriendsState } from '@/app/lib/use-friends'
import { watchHistory } from '@/features/library/own-library/own-library.test-helpers'
import { FriendsPageContent } from './FriendsPageContent'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: jest.requireActual<
    typeof import('@/features/library/own-library/own-library.test-helpers')
  >('@/features/library/own-library/own-library.test-helpers').useAddressSearchParams,
}))

let mockFriendsState: FriendsState = { status: 'loading' }
const mockReload = jest.fn()

jest.mock('@/app/lib/use-friends', () => ({
  useFriends: () => ({ state: mockFriendsState, reload: mockReload }),
}))

jest.mock('@/features/network/index.client', () => ({
  InviteManager: () => <h2>Запросити друзів</h2>,
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const friend: Friend = {
  user: { id: 'friend-1', displayName: 'Олена Коваль', handle: 'olena', avatarUrl: null },
  friendsSince: '2026-08-20T10:00:00.000Z',
}

const incoming: FriendRequest = {
  id: 'request-incoming',
  user: { id: 'incoming-1', displayName: 'Марко Левченко', handle: 'marko', avatarUrl: null },
  createdAt: '2026-08-24T10:00:00.000Z',
}

const outgoing: FriendRequest = {
  id: 'request-outgoing',
  user: { id: 'outgoing-1', displayName: 'Ірина Бондар', handle: 'iryna', avatarUrl: null },
  createdAt: '2026-08-23T10:00:00.000Z',
}

const READY: FriendsState = {
  status: 'ready',
  friends: [friend],
  incoming: [incoming],
  outgoing: [outgoing],
}

let unwatch: () => void = () => undefined

beforeAll(() => {
  // jsdom has no modal dialogs: `showModal()` and `close()` only toggle `open`.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

beforeEach(() => {
  apiRequest.mockReset()
  mockPush.mockReset()
  mockReload.mockReset()
  mockFriendsState = READY
  window.history.replaceState(null, '', '/friends')
  unwatch = watchHistory()
})

afterEach(() => {
  unwatch()
})

function tab(name: RegExp) {
  return screen.getByRole('tab', { name })
}

describe('FriendsPageContent', () => {
  it('opens «Мої друзі» with the friends count and the waiting requests count', () => {
    render(<FriendsPageContent />)

    expect(tab(/^Мої друзі/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/^Мої друзі/)).toHaveTextContent('Мої друзі1')
    expect(tab(/^Запити/)).toHaveTextContent('Запити1')
    expect(tab(/^Знайти друзів/)).toHaveTextContent(/^Знайти друзів$/)
    expect(screen.getByRole('link', { name: 'Олена Коваль' })).toBeInTheDocument()
  })

  it('opens the tab the address names and writes the chosen one back', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/friends?tab=requests')

    render(<FriendsPageContent />)

    expect(tab(/^Запити/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Хочуть додати вас' })).toBeInTheDocument()

    await user.click(tab(/^Знайти друзів/))
    expect(window.location.search).toBe('?tab=find')
    expect(screen.getByRole('search', { name: 'Пошук людей' })).toBeInTheDocument()

    await user.click(tab(/^Мої друзі/))
    expect(window.location.pathname + window.location.search).toBe('/friends')
    expect(screen.getByRole('list', { name: 'Мої друзі' })).toBeInTheDocument()
  })

  it('accepts a request in place: the row says so, links the library and takes the focus', async () => {
    const user = userEvent.setup()
    apiRequest.mockResolvedValue({ relation: 'FRIENDS' })
    window.history.replaceState(null, '', '/friends?tab=requests')

    render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Прийняти запит від Марко Левченко' }))

    expect(apiRequest).toHaveBeenCalledWith(
      '/friends/requests/request-incoming',
      expect.objectContaining({ method: 'PATCH', body: { action: 'accept' } }),
    )
    const outcome = await screen.findByRole('status')

    expect(outcome).toHaveTextContent('Тепер ви друзі')
    await waitFor(() => expect(outcome).toHaveFocus())
    expect(screen.getByRole('link', { name: 'Бібліотека: Марко Левченко' })).toHaveAttribute(
      'href',
      '/u/marko',
    )
    // Answered, so no longer waiting: the warm count goes.
    expect(tab(/^Запити/)).toHaveTextContent(/^Запити$/)
  })

  it('keeps the outcome after the lists are read again without the request', async () => {
    const user = userEvent.setup()
    apiRequest.mockResolvedValue({ relation: 'NONE' })
    window.history.replaceState(null, '', '/friends?tab=requests')

    const { rerender } = render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Відхилити запит від Марко Левченко' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Запит відхилено')

    mockFriendsState = { ...READY, incoming: [] }
    rerender(<FriendsPageContent />)

    expect(screen.getByRole('status')).toHaveTextContent('Запит відхилено')
    expect(
      screen.queryByRole('button', { name: 'Прийняти запит від Марко Левченко' }),
    ).not.toBeInTheDocument()
  })

  it('shows a failed answer as an alert and keeps the buttons', async () => {
    const user = userEvent.setup()
    apiRequest.mockRejectedValue(
      new ApiRequestError(409, { code: 'CONFLICT', message: 'Запит уже не чинний' }),
    )
    window.history.replaceState(null, '', '/friends?tab=requests')

    render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Прийняти запит від Марко Левченко' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Запит уже не чинний')
    expect(screen.getByRole('button', { name: 'Прийняти запит від Марко Левченко' })).toBeEnabled()
  })

  it('asks before cancelling an outgoing request and cancels it on confirm', async () => {
    const user = userEvent.setup()
    apiRequest.mockResolvedValue(undefined)
    window.history.replaceState(null, '', '/friends?tab=requests')

    render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Скасувати запит до Ірина Бондар' }))

    const dialog = screen.getByRole('alertdialog', { name: 'Скасувати запит до Ірина Бондар?' })

    expect(apiRequest).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати запит' }))
    expect(apiRequest).toHaveBeenCalledWith('/friends/outgoing-1', { method: 'DELETE' })
  })

  it('asks before removing and before blocking a friend', async () => {
    const user = userEvent.setup()
    apiRequest.mockResolvedValue(undefined)

    render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Дії з другом Олена Коваль' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Видалити з друзів' }))

    const remove = screen.getByRole('alertdialog', { name: 'Видалити Олена Коваль з друзів?' })

    await user.click(within(remove).getByRole('button', { name: 'Скасувати' }))
    expect(apiRequest).not.toHaveBeenCalled()
    // The menu item that opened it is gone: the focus goes back to «⋯».
    expect(screen.getByRole('button', { name: 'Дії з другом Олена Коваль' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Дії з другом Олена Коваль' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Заблокувати' }))

    const block = screen.getByRole('alertdialog', { name: 'Заблокувати Олена Коваль?' })

    await user.click(within(block).getByRole('button', { name: 'Заблокувати' }))
    expect(apiRequest).toHaveBeenCalledWith('/friends/friend-1/block', { method: 'POST' })
  })

  it('says each request list is empty instead of leaving a gap', () => {
    mockFriendsState = { ...READY, incoming: [], outgoing: [] }
    window.history.replaceState(null, '', '/friends?tab=requests')

    render(<FriendsPageContent />)

    expect(screen.getByText('Нових запитів немає.')).toBeInTheDocument()
    expect(screen.getByText('Ви не чекаєте відповіді на жоден запит.')).toBeInTheDocument()
    expect(tab(/^Запити/)).toHaveTextContent(/^Запити$/)
  })

  it('shows the tabs while the lists load, then a retryable error', async () => {
    const user = userEvent.setup()
    mockFriendsState = { status: 'loading' }

    const { rerender } = render(<FriendsPageContent />)

    expect(screen.getByLabelText('Завантажую друзів')).toBeInTheDocument()
    expect(tab(/^Мої друзі/)).toHaveTextContent(/^Мої друзі$/)

    mockFriendsState = { status: 'error', message: 'Друзів не завантажено' }
    rerender(<FriendsPageContent />)

    expect(screen.getByRole('alert')).toHaveTextContent('Друзів не завантажено')
    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(mockReload).toHaveBeenCalledTimes(1)
  })

  it('opens the people search with the typed text from «Знайти друзів»', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/friends?tab=find')

    render(<FriendsPageContent />)

    expect(screen.getByRole('heading', { name: 'Запросити друзів' })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Ім’я або email' }), 'Олена{Enter}')
    expect(mockPush).toHaveBeenCalledWith('/friends/search?query=%D0%9E%D0%BB%D0%B5%D0%BD%D0%B0')
  })

  it('points an empty friends list to «Знайти друзів»', async () => {
    const user = userEvent.setup()
    mockFriendsState = { ...READY, friends: [] }

    render(<FriendsPageContent />)
    await user.click(screen.getByRole('button', { name: 'Знайти нових друзів' }))

    await act(async () => undefined)
    expect(window.location.search).toBe('?tab=find')
    expect(tab(/^Знайти друзів/)).toHaveAttribute('aria-selected', 'true')
  })
})
