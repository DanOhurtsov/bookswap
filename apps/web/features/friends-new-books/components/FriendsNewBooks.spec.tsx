/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FriendsNewBook, FriendsNewBooksResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { installCarouselEnvironment } from './carousel-test-env'
import { FriendsNewBooks } from './FriendsNewBooks'

/**
 * BS-147: «Нове в бібліотеках друзів» by role, label and text. `apiRequest` and the session are
 * replaced; an account change with the real `SessionProvider` and `Providers` is in
 * `FriendsNewBooks.account-switch.spec`. jsdom lays nothing out, so whether the arrows show and how
 * the carousel moves is checked in the browser (`friends-new-books.browser-spec`).
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

const FEED_PATH = '/me/friends/new-books'
const SECTION = 'Нове в бібліотеках друзів'

installCarouselEnvironment()

function signedIn(id: string): SessionState {
  return { status: 'authenticated', user: { id } } as SessionState
}

const item = (
  friend: { id: string; displayName: string },
  work: { id: string; title: string },
  coverUrl: string | null = null,
): FriendsNewBook => ({
  friend: { ...friend, handle: `${friend.id}-handle`, avatarUrl: null },
  work,
  authors: [{ id: 'a-1', name: 'Ліна Костенко', nameLatin: null, role: 'AUTHOR', position: 0 }],
  coverUrl,
  // Two days before any time these tests run: the relative wording itself is the model's spec.
  addedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
})

const feed = (hasFriends: boolean, items: FriendsNewBook[] = []): FriendsNewBooksResponse => ({
  hasFriends,
  items,
})

function feedRequests(): unknown[] {
  return apiRequest.mock.calls.filter(([path]) => path === FEED_PATH)
}

function section(): HTMLElement {
  return screen.getByRole('region', { name: SECTION })
}

function renderFeed() {
  return render(withQueryClient(<FriendsNewBooks />))
}

beforeEach(() => {
  apiRequest.mockReset()
  session = signedIn('me')
})

describe('FriendsNewBooks (BS-147)', () => {
  it.each<[string, SessionState]>([
    ['a guest', { status: 'guest' }],
    ['a session still loading', { status: 'loading' }],
    ['a failed session', { status: 'error', message: 'Збій' }],
  ])('for %s there is no section and no request', (_name, state) => {
    session = state

    renderFeed()

    expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('is one section named in full, at every width — the short phone heading is not read aloud', async () => {
    apiRequest.mockResolvedValue(feed(true))

    renderFeed()

    expect(await screen.findByRole('heading', { level: 2, name: SECTION })).toBeInTheDocument()
    expect(screen.getByText('Нове в друзів')).toHaveAttribute('aria-hidden', 'true')
  })

  it('says it is loading while the first answer is on its way', async () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    renderFeed()

    expect(within(section()).getByText('Шукаю нові книжки друзів…')).toBeInTheDocument()
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

    expect(alert).toHaveTextContent('Не вдалося завантажити нові книжки друзів. Сервер недоступний')
    expect(feedRequests()).toHaveLength(1)

    await user.click(within(alert).getByRole('button', { name: 'Спробувати ще раз' }))

    expect(
      await within(section()).findByRole('link', { name: /^Маруся Чурай, Ліна Костенко/ }),
    ).toBeInTheDocument()
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument()
    expect(feedRequests()).toHaveLength(2)
  })

  it.each([
    ['no friends', false],
    ['friends with nothing new', true],
  ])(
    'with %s: the canvas’s empty row and an invitation to the friends page',
    async (_name, has) => {
      apiRequest.mockResolvedValue(feed(has))

      renderFeed()

      expect(await within(section()).findByText('Друзі ще нічого не додали')).toBeInTheDocument()
      expect(
        within(section()).getByText('Запросіть більше друзів, щоб бачити нові книжки.'),
      ).toBeInTheDocument()
      expect(within(section()).getByRole('link', { name: 'Запросити' })).toHaveAttribute(
        'href',
        '/friends',
      )
      expect(section()).toHaveAttribute('aria-busy', 'false')
    },
  )

  it('each card is one link to the work, named by title, author, friend and when; the friend is a caption', async () => {
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

    // The ready feed is a new element — the carousel root — so the section is looked up again.
    await screen.findAllByRole('group')

    const slides = within(section()).getAllByRole('group')

    expect(slides).toHaveLength(2)

    const [first, second] = slides as [HTMLElement, HTMLElement]
    const firstLinks = within(first).getAllByRole('link')

    expect(firstLinks).toHaveLength(1)
    expect(firstLinks[0]).toHaveAttribute('href', '/works/w-1')
    expect(firstLinks[0]).toHaveAccessibleName(
      'Маруся Чурай, Ліна Костенко. Додано: Марта, 2 дні тому',
    )
    expect(firstLinks[0]!.querySelector('a')).toBeNull()
    expect(first).toHaveTextContent('Марта · 2 дні тому')
    expect(within(first).getByText('2 дні тому')).toHaveAttribute(
      'dateTime',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    )
    // The picture is decorative: the link already names the book.
    expect(first.querySelector('img')).toHaveAttribute('src', 'https://covers.example/1.jpg')
    expect(first.querySelector('img')).toHaveAttribute('alt', '')

    // No cover: the cover drawn from the title and the author.
    expect(second.querySelector('img')).toBeNull()
    expect(second.querySelector('[data-slot="drawn-cover"]')).toHaveTextContent('Маруся Чурай')
    expect(within(second).getAllByRole('link')).toHaveLength(1)

    expect(section()).not.toHaveAttribute('aria-busy', 'true')
    expect(apiRequest).toHaveBeenCalledWith(
      FEED_PATH,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('with nothing to scroll there are no arrows, and nothing plays on its own', async () => {
    apiRequest.mockResolvedValue(
      feed(true, [item({ id: 'f-1', displayName: 'Марта' }, { id: 'w-1', title: 'Маруся Чурай' })]),
    )

    renderFeed()

    await screen.findAllByRole('group')

    // jsdom has no layout: Embla sees nothing to scroll, so — as with a few cards — no arrows at all.
    expect(within(section()).queryByRole('button')).not.toBeInTheDocument()
    expect(section()).toHaveAttribute('aria-roledescription', 'карусель')
  })
})
