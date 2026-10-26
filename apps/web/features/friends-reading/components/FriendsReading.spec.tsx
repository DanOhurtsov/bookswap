/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FriendsReadingItem, FriendsReadingResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { FriendsReading } from './FriendsReading'

/**
 * BS-137: «Що читають мої друзі» by role, label and text. `apiRequest` and the session are replaced;
 * an account change with the real `SessionProvider` and `Providers` is in
 * `FriendsReading.account-switch.spec`.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let session: SessionState

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: session }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const FEED_PATH = '/me/friends/reading'
const SECTION = 'Що читають мої друзі'

function signedIn(id: string): SessionState {
  return { status: 'authenticated', user: { id } } as SessionState
}

const item = (
  friend: { id: string; displayName: string },
  work: { id: string; title: string },
  coverUrl: string | null = null,
): FriendsReadingItem => ({
  friend: { ...friend, avatarUrl: null },
  work,
  authors: [{ id: 'a-1', name: 'Ліна Костенко', nameLatin: null, role: 'AUTHOR', position: 0 }],
  coverUrl,
  updatedAt: '2026-10-20T10:00:00.000Z',
})

const feed = (hasFriends: boolean, items: FriendsReadingItem[] = []): FriendsReadingResponse => ({
  hasFriends,
  items,
  nextCursor: null,
})

function feedRequests(): unknown[] {
  return apiRequest.mock.calls.filter(([path]) => path === FEED_PATH)
}

function section(): HTMLElement {
  return screen.getByRole('region', { name: SECTION })
}

function renderFeed() {
  return render(withQueryClient(<FriendsReading />))
}

beforeEach(() => {
  apiRequest.mockReset()
  session = signedIn('me')
})

describe('FriendsReading (BS-137)', () => {
  it.each<[string, SessionState]>([
    ['a guest', { status: 'guest' }],
    ['a session still loading', { status: 'loading' }],
    ['a failed session', { status: 'error', message: 'Збій' }],
  ])('for %s there is no section and no request', (_name, state) => {
    session = state

    renderFeed()

    expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()
    expect(screen.queryByText(SECTION)).not.toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('says it is loading while the first answer is on its way', async () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    renderFeed()

    expect(within(section()).getByRole('status')).toHaveTextContent('Дивлюся, що читають друзі…')
    expect(section()).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => {
      expect(feedRequests()).toHaveLength(1)
    })
  })

  it('shows an error with a manual retry, does not retry on its own, and recovers on retry', async () => {
    const user = userEvent.setup()

    apiRequest
      .mockRejectedValueOnce(
        new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
      )
      .mockResolvedValueOnce(
        feed(true, [
          item({ id: 'f-1', displayName: 'Марта' }, { id: 'w-1', title: 'Маруся Чурай' }),
        ]),
      )

    renderFeed()

    const alert = await within(section()).findByRole('alert')

    expect(alert).toHaveTextContent('Не вдалося завантажити, що читають друзі. Сервер недоступний')
    expect(feedRequests()).toHaveLength(1)

    await user.click(within(alert).getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await within(section()).findByRole('link', { name: 'Маруся Чурай' })).toBeInTheDocument()
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument()
    expect(feedRequests()).toHaveLength(2)
  })

  it('with no friends it invites to find some, linking to the user search', async () => {
    apiRequest.mockResolvedValue(feed(false))

    renderFeed()

    expect(
      await within(section()).findByText('Додайте друзів, щоб бачити, що вони зараз читають.'),
    ).toBeInTheDocument()
    expect(within(section()).getByRole('link', { name: 'Знайти друзів' })).toHaveAttribute(
      'href',
      '/friends/search',
    )
    expect(within(section()).queryByRole('list')).not.toBeInTheDocument()
  })

  it('with friends who read nothing it says so, without the invitation', async () => {
    apiRequest.mockResolvedValue(feed(true))

    renderFeed()

    expect(
      await within(section()).findByText('Зараз ніхто з ваших друзів нічого не читає.'),
    ).toBeInTheDocument()
    expect(within(section()).queryByRole('link', { name: 'Знайти друзів' })).not.toBeInTheDocument()
    expect(within(section()).queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows a card per friend and work: cover, title, author, friend, and both links', async () => {
    apiRequest.mockResolvedValue(
      feed(true, [
        item(
          { id: 'f-1', displayName: 'Марта' },
          { id: 'w-1', title: 'Маруся Чурай' },
          'https://covers.example/1.jpg',
        ),
        item({ id: 'f-2', displayName: 'Олесь' }, { id: 'w-1', title: 'Маруся Чурай' }),
      ]),
    )

    renderFeed()

    const cards = await within(section()).findAllByRole('listitem')

    expect(cards).toHaveLength(2)

    const [first, second] = cards as [HTMLElement, HTMLElement]

    expect(within(first).getByRole('img', { name: 'Обкладинка «Маруся Чурай»' })).toHaveAttribute(
      'src',
      'https://covers.example/1.jpg',
    )
    expect(within(first).getByRole('link', { name: 'Маруся Чурай' })).toHaveAttribute(
      'href',
      '/works/w-1',
    )
    expect(within(first).getByText('Ліна Костенко')).toBeInTheDocument()
    expect(first).toHaveTextContent('Читає')
    expect(within(first).getByRole('link', { name: 'Марта' })).toHaveAttribute(
      'href',
      '/users/f-1/library',
    )

    // No cover: the placeholder, not an image that is not there.
    expect(within(second).queryByRole('img', { name: /Обкладинка/ })).not.toBeInTheDocument()
    expect(second.querySelector('[data-slot="book-cover-placeholder"]')).not.toBeNull()
    expect(within(second).getByRole('link', { name: 'Олесь' })).toHaveAttribute(
      'href',
      '/users/f-2/library',
    )

    // Two separate links per card, neither inside the other; the title comes first.
    for (const card of cards) {
      const links = within(card).getAllByRole('link')

      expect(links).toHaveLength(2)
      expect(links[0]).toHaveAttribute('href', '/works/w-1')
      expect(links[0]!.querySelector('a')).toBeNull()
      expect(links[1]!.querySelector('a')).toBeNull()
    }

    expect(section()).toHaveAttribute('aria-busy', 'false')
    expect(section().querySelector('.result-grid > ul')).not.toBeNull()
    expect(apiRequest).toHaveBeenCalledWith(
      FEED_PATH,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('loads only the first cover eagerly — it is above the fold — and the rest lazily', async () => {
    apiRequest.mockResolvedValue(
      feed(true, [
        item(
          { id: 'f-1', displayName: 'Марта' },
          { id: 'w-1', title: 'Маруся Чурай' },
          'https://covers.example/1.jpg',
        ),
        item(
          { id: 'f-2', displayName: 'Олесь' },
          { id: 'w-2', title: 'Сад нетанучих скульптур' },
          'https://covers.example/2.jpg',
        ),
        item(
          { id: 'f-3', displayName: 'Ірина' },
          { id: 'w-3', title: 'Берестечко' },
          'https://covers.example/3.jpg',
        ),
      ]),
    )

    renderFeed()

    const cards = await within(section()).findAllByRole('listitem')
    const loading = cards.map((card) =>
      within(card)
        .getByRole('img', { name: /Обкладинка/ })
        .getAttribute('loading'),
    )

    expect(loading).toEqual(['eager', 'lazy', 'lazy'])
  })
})
