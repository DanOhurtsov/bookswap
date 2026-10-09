/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Notification } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { useFriends } from '@/app/lib/use-friends'
import {
  MARTA,
  NETWORK_ERROR,
  OLES,
  createFakeServer,
  friendRequested,
  pendingRequest,
  type FakeServer,
} from '@/features/friend-requests/friend-requests.test-helpers'
import { NavBarNotifications } from './NavBarNotifications'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const martaRequest = pendingRequest(MARTA, 'friendship-marta')
const olesRequest = pendingRequest(OLES, 'friendship-oles')

/** The friends page's legacy reader, mounted under the open panel. */
function FriendsProbe() {
  const { state } = useFriends()

  if (state.status !== 'ready') return null

  return (
    <p>
      Друзі на сторінці:{' '}
      {state.friends.map((friend) => friend.user.displayName).join(', ') || 'нікого'}
    </p>
  )
}

let server: FakeServer

function serve(notifications: Notification[], incoming = [martaRequest]): void {
  server = createFakeServer({ notifications, incoming })
  apiRequest.mockImplementation(server.handle)
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    withQueryClient(
      <>
        <NavBarNotifications />
        <FriendsProbe />
      </>,
    ),
  )

  await user.click(await screen.findByRole('button', { name: /^Відкрити сповіщення/ }))

  return screen.findByRole('dialog', { name: 'Сповіщення' })
}

async function requestGroup(panel: HTMLElement, name: string): Promise<HTMLElement> {
  return within(panel).findByRole('group', { name: `Запит у друзі від ${name}` })
}

const respondCalls = (friendshipId: string) =>
  server.count(`PATCH /friends/requests/${friendshipId}`)

beforeEach(() => {
  apiRequest.mockReset()
  mockPush.mockReset()
})

describe('NavBarNotifications: відповідь на запит у друзі з панелі', () => {
  it('прийняття не закриває панель і не навігує; кнопки зникають, лічильник і друзі оновлюються', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)])

    const panel = await openPanel(user)
    const group = await requestGroup(panel, MARTA.displayName)

    expect(within(group).getByText('МК')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Непрочитані (1)' })).toBeVisible()

    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(
      await within(panel).findByText(`Запит прийнято — тепер ви друзі з ${MARTA.displayName}.`),
    ).toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Сповіщення' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Непрочитані' })).toBeVisible(),
    )
    expect(screen.getByText(`Друзі на сторінці: ${MARTA.displayName}`)).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('відхилення без підтвердження: у «Непрочитаних» сповіщення зникає, в «Усіх» лишається', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)])

    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: /^Непрочитані/ }))
    await user.click(
      within(await requestGroup(panel, MARTA.displayName)).getByRole('button', {
        name: 'Відхилити',
      }),
    )

    expect(await within(panel).findByText('Непрочитаних сповіщень немає.')).toBeVisible()
    expect(respondCalls(martaRequest.id)).toBe(1)
    expect(screen.getByText('Друзі на сторінці: нікого')).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Усі' }))

    expect(
      await within(panel).findByText(`Запит від ${MARTA.displayName} відхилено.`),
    ).toBeVisible()
    expect(within(panel).getByText('Новий запит у друзі')).toBeVisible()
  })

  it('прочитаний активний запит має кнопки; відповідь не шле зайвого позначення прочитаним', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-oles', olesRequest, '2026-10-02T10:00:00.000Z')], [olesRequest])

    const panel = await openPanel(user)
    const group = await requestGroup(panel, OLES.displayName)

    await user.click(within(group).getByRole('button', { name: 'Відхилити' }))

    expect(await within(panel).findByText(`Запит від ${OLES.displayName} відхилено.`)).toBeVisible()
    expect(server.count('PATCH /me/notifications/n-oles/read')).toBe(0)
  })

  it('блокує обидві кнопки; подвійний клік — одна операція', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)])

    const panel = await openPanel(user)
    const release = server.holdNext('respond')
    const group = await requestGroup(panel, MARTA.displayName)

    await user.dblClick(within(group).getByRole('button', { name: 'Відхилити' }))

    expect(within(group).getByRole('button', { name: 'Відхиляю…' })).toBeDisabled()
    expect(within(group).getByRole('button', { name: 'Прийняти' })).toBeDisabled()

    release()

    expect(await within(panel).findByText(/відхилено\.$/)).toBeVisible()
    expect(respondCalls(martaRequest.id)).toBe(1)
  })

  it('помилка API лишає можливість повторити; частковий успіх повторює лише прочитання', async () => {
    const user = userEvent.setup()

    serve([friendRequested('n-marta', martaRequest)])

    const panel = await openPanel(user)
    const group = await requestGroup(panel, MARTA.displayName)

    server.failNext(
      'respond',
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }),
    )
    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(await within(group).findByText('Збій сервера')).toBeVisible()
    expect(within(panel).queryByText(/^Запит прийнято/)).not.toBeInTheDocument()

    server.failNext('read', NETWORK_ERROR)
    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(
      await within(panel).findByText('Не вдалося позначити сповіщення прочитаним.'),
    ).toBeVisible()
    expect(within(panel).getByText(/^Запит прийнято/)).toBeVisible()

    await user.click(within(panel).getByRole('button', { name: 'Позначити прочитаним ще раз' }))

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Непрочитані' })).toBeVisible(),
    )
    expect(respondCalls(martaRequest.id)).toBe(2)
    expect(server.count('PATCH /me/notifications/n-marta/read')).toBe(2)
  })

  it('застарілий запит і видалений ініціатор: дій немає, пояснення є', async () => {
    const user = userEvent.setup()
    const goneRequest = pendingRequest(
      { id: 'user-gone', displayName: 'Видалений', avatarUrl: null },
      'friendship-gone',
    )

    serve([friendRequested('n-marta', martaRequest), friendRequested('n-gone', goneRequest)])

    const panel = await openPanel(user)

    expect(await within(panel).findByText('Запит більше не очікує відповіді.')).toBeVisible()
    expect(within(panel).queryByText('Видалений')).not.toBeInTheDocument()

    // Запит відкликали вже після того, як панель його показала.
    server.state.incoming = []
    await user.click(
      within(await requestGroup(panel, MARTA.displayName)).getByRole('button', {
        name: 'Прийняти',
      }),
    )

    expect(
      await within(panel).findByText(/^Відповісти не вдалося: запит уже відкликали/),
    ).toBeVisible()
    expect(within(panel).queryByRole('button', { name: 'Прийняти' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Сповіщення' })).toBeInTheDocument()
  })
})
