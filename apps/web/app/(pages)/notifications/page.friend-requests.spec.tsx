/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Notification } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { useFriends } from '@/app/lib/use-friends'
import type { SessionState } from '@/app/lib/use-session'
import { NavBarNotifications } from '@/components/NavBar/NavBarNotifications'
import {
  MARTA,
  NETWORK_ERROR,
  OLES,
  createFakeServer,
  friendRequested,
  pendingRequest,
  type FakeServer,
} from '@/features/friend-requests/friend-requests.test-helpers'
import NotificationsPage from './page'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockPush = jest.fn()
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

const mockSession: SessionState = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  features: { guestLoans: true },
}

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const martaRequest = pendingRequest(MARTA, 'friendship-marta')
const olesRequest = pendingRequest(OLES, 'friendship-oles')

/** The friends page's legacy reader, mounted next to the notifications page. */
function FriendsProbe() {
  const { state } = useFriends()

  if (state.status !== 'ready') return null

  const names = (users: { displayName: string }[]) =>
    users.map((user) => user.displayName).join(', ') || 'нікого'

  return (
    <section aria-label="Сторінка друзів">
      <p>Вхідні: {names(state.incoming.map((request) => request.user))}</p>
      <p>Друзі: {names(state.friends.map((friend) => friend.user))}</p>
    </section>
  )
}

let server: FakeServer

function serve(notifications: Notification[], incoming = [martaRequest, olesRequest]): void {
  server = createFakeServer({ notifications, incoming })
  apiRequest.mockImplementation(server.handle)
}

function renderScreen() {
  return render(
    withQueryClient(
      <>
        <NavBarNotifications />
        <NotificationsPage />
        <FriendsProbe />
      </>,
    ),
  )
}

async function requestGroup(name: string): Promise<HTMLElement> {
  return screen.findByRole('group', { name: `Запит у друзі від ${name}` })
}

const respondCalls = (friendshipId: string) =>
  server.count(`PATCH /friends/requests/${friendshipId}`)

beforeEach(() => {
  apiRequest.mockReset()
  mockPush.mockReset()
  mockReplace.mockReset()
})

describe('NotificationsPage: відповідь на запит у друзі', () => {
  it('показує ініціатора з аватаром-ініціалами й обидві кнопки одним запитом на весь список', async () => {
    serve([friendRequested('n-marta', martaRequest), friendRequested('n-oles', olesRequest)])
    renderScreen()

    const group = await requestGroup(MARTA.displayName)

    expect(within(group).getByText(MARTA.displayName)).toBeVisible()
    // Без аватара (і з аватаром, що не завантажився) — ініціали, а не порожнє коло.
    expect(within(group).getByText('МК')).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Прийняти' })).toBeEnabled()
    expect(within(group).getByRole('button', { name: 'Відхилити' })).toBeEnabled()
    expect(await requestGroup(OLES.displayName)).toBeInTheDocument()
    // Для двох сповіщень — один GET /friends/requests від екрана сповіщень і один від useFriends.
    expect(server.count('GET /friends/requests')).toBe(2)
  })

  it('прийняття: без навігації, кнопки зникають, сповіщення прочитане, лічильник і друзі оновлюються', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()

    expect(
      await screen.findByRole('button', { name: 'Відкрити сповіщення: 1 непрочитаних' }),
    ).toBeVisible()

    await user.click(
      within(await requestGroup(MARTA.displayName)).getByRole('button', { name: 'Прийняти' }),
    )

    expect(
      await screen.findByText(`Запит прийнято — тепер ви друзі з ${MARTA.displayName}.`),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
    expect(server.state.notifications[0]?.readAt).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Відкрити сповіщення' })).toBeVisible()

    const friendsPage = screen.getByRole('region', { name: 'Сторінка друзів' })

    await waitFor(() => expect(friendsPage).toHaveTextContent(`Друзі: ${MARTA.displayName}`))
    expect(friendsPage).toHaveTextContent('Вхідні: нікого')
    expect(server.state.friends.map((friend) => friend.user.id)).toEqual([MARTA.id])
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('відхилення: без підтвердження, «Непрочитані» його прибирає, «Усі» лишає в історії', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()

    await user.click(screen.getByRole('button', { name: /^Непрочитані/ }))
    await user.click(
      within(await requestGroup(MARTA.displayName)).getByRole('button', { name: 'Відхилити' }),
    )

    expect(respondCalls(martaRequest.id)).toBe(1)
    await waitFor(() => expect(screen.getByText('Непрочитаних немає.')).toBeVisible())
    expect(server.state.friends).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Усі' }))

    const row = (await screen.findByText('Новий запит у друзі')).closest('li')

    expect(row).not.toBeNull()
    expect(row).not.toHaveTextContent('нове')
    expect(within(row!).queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
    expect(within(row!).getByText(`Запит від ${MARTA.displayName} відхилено.`)).toBeVisible()
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Сторінка друзів' })).toHaveTextContent(
        'Вхідні: нікого',
      ),
    )
  })

  it('прочитаний, але ще активний запит теж має кнопки, і зайвого позначення прочитаним немає', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-oles', olesRequest, '2026-10-02T10:00:00.000Z')], [olesRequest])
    renderScreen()

    const group = await requestGroup(OLES.displayName)

    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(
      await screen.findByText(`Запит прийнято — тепер ви друзі з ${OLES.displayName}.`),
    ).toBeVisible()
    expect(server.count('PATCH /me/notifications/n-oles/read')).toBe(0)
  })

  it('блокує обидві кнопки на час запиту; повторний клік не створює другої операції', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()

    const release = server.holdNext('respond')
    const group = await requestGroup(MARTA.displayName)

    await user.dblClick(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(within(group).getByRole('button', { name: 'Приймаю…' })).toBeDisabled()
    expect(within(group).getByRole('button', { name: 'Відхилити' })).toBeDisabled()
    expect(group).toHaveAttribute('aria-busy', 'true')

    await user.click(within(group).getByRole('button', { name: 'Відхилити' }))
    release()

    expect(await screen.findByText(/^Запит прийнято/)).toBeVisible()
    expect(respondCalls(martaRequest.id)).toBe(1)
  })

  it('мережева помилка: успіху не показує, кнопки лишаються, повтор спрацьовує', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()
    server.failNext('respond', NETWORK_ERROR)

    const group = await requestGroup(MARTA.displayName)

    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(
      await within(group).findByText('Не вдалося відповісти — спробуйте ще раз.'),
    ).toBeVisible()
    expect(screen.queryByText(/^Запит прийнято/)).not.toBeInTheDocument()
    expect(server.state.notifications[0]?.readAt).toBeNull()

    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(await screen.findByText(/^Запит прийнято/)).toBeVisible()
    expect(respondCalls(martaRequest.id)).toBe(2)
  })

  it('частковий успіх: дружба лишається прийнятою, повторюється лише позначення прочитаним', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()
    server.failNext('read', NETWORK_ERROR)

    await user.click(
      within(await requestGroup(MARTA.displayName)).getByRole('button', { name: 'Прийняти' }),
    )

    expect(await screen.findByText('Не вдалося позначити сповіщення прочитаним.')).toBeVisible()
    expect(screen.getByText(/^Запит прийнято/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Позначити прочитаним ще раз' }))

    await waitFor(() => expect(server.state.notifications[0]?.readAt).not.toBeNull())
    expect(
      screen.queryByText('Не вдалося позначити сповіщення прочитаним.'),
    ).not.toBeInTheDocument()
    expect(server.count('PATCH /me/notifications/n-marta/read')).toBe(2)
    expect(respondCalls(martaRequest.id)).toBe(1)
  })

  it('застарілий запит (уже оброблений деінде): дії зникають, людина бачить, чому', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)], [martaRequest])
    renderScreen()

    const group = await requestGroup(MARTA.displayName)

    // Між завантаженням і кліком запит прийняли в іншій вкладці.
    server.state.incoming = []
    await user.click(within(group).getByRole('button', { name: 'Відхилити' }))

    expect(
      await screen.findByText(
        'Відповісти не вдалося: запит уже відкликали, обробили раніше або користувач недоступний.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
    expect(screen.queryByText(/відхилено/)).not.toBeInTheDocument()
  })

  it('видалений ініціатор: 404 прибирає дії; сповіщення без актуального запиту кнопок не має', async () => {
    const user = userEvent.setup()
    const goneRequest = pendingRequest(
      { id: 'user-gone', displayName: 'Видалений', avatarUrl: null },
      'friendship-gone',
    )

    serve(
      [friendRequested('n-marta', martaRequest), friendRequested('n-gone', goneRequest)],
      [martaRequest],
    )
    renderScreen()

    expect(await screen.findByText('Запит більше не очікує відповіді.')).toBeVisible()
    expect(screen.queryByText('Видалений')).not.toBeInTheDocument()

    server.failNext(
      'respond',
      new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Запит не знайдено' }),
    )
    await user.click(
      within(await requestGroup(MARTA.displayName)).getByRole('button', { name: 'Прийняти' }),
    )

    expect(await screen.findByText(/^Відповісти не вдалося: запит уже відкликали/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
  })
})
