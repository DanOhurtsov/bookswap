/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Notification } from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { NavBarNotifications } from '@/components/NavBar/NavBarNotifications'
import {
  MARTA,
  NETWORK_ERROR,
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

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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

const LOAN_REQUESTED: Notification = {
  id: 'n-loan',
  type: 'LOAN_REQUESTED',
  payload: { loanId: 'loan-1', copyId: 'copy-1', actorId: 'user-2' },
  readAt: null,
  createdAt: '2026-10-02T10:00:00.000Z',
}

const LOAN_APPROVED_READ: Notification = {
  id: 'n-approved',
  type: 'LOAN_APPROVED',
  payload: { loanId: 'loan-2', copyId: 'copy-2', actorId: 'user-2' },
  readAt: '2026-10-01T12:00:00.000Z',
  createdAt: '2026-10-01T11:00:00.000Z',
}

let server: FakeServer

function serve(): void {
  server = createFakeServer({
    notifications: [LOAN_REQUESTED, friendRequested('n-marta', martaRequest), LOAN_APPROVED_READ],
    incoming: [martaRequest],
  })
  apiRequest.mockImplementation(server.handle)
}

/** The navbar is mounted on every page, so `/notifications` always has two readers. */
function renderScreen() {
  return render(
    withQueryClient(
      <>
        <NavBarNotifications />
        <NotificationsPage />
      </>,
    ),
  )
}

const readAllCalls = () => server.count('POST /me/notifications/read-all')

function rowOf(label: string, scope: HTMLElement = document.body): HTMLElement {
  const row = within(scope).getByText(label).closest('li')

  if (row === null) throw new Error(`Немає рядка «${label}»`)

  return row
}

beforeEach(() => {
  apiRequest.mockReset()
  serve()
})

describe('NotificationsPage: усі / непрочитані й «Прочитати всі» (BS-127)', () => {
  it('«Непрочитані» показує лише сповіщення без readAt, «Усі» — усю історію', async () => {
    const user = userEvent.setup()

    renderScreen()

    expect(await screen.findByText('Ваше прохання погодили')).toBeVisible()

    await user.click(screen.getByRole('button', { name: /^Непрочитані/ }))

    expect(await screen.findByText('У вас просять книжку')).toBeVisible()
    expect(screen.getByText('Новий запит у друзі')).toBeVisible()
    expect(screen.queryByText('Ваше прохання погодили')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Усі' }))

    expect(await screen.findByText('Ваше прохання погодили')).toBeVisible()
  })

  it('позначає все прочитаним без видалення історії; лічильник на дзвіночку оновлюється, кнопка гасне', async () => {
    const user = userEvent.setup()

    renderScreen()

    expect(
      await screen.findByRole('button', { name: 'Відкрити сповіщення: 2 непрочитаних' }),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Прочитати всі' }))

    expect(await screen.findByRole('button', { name: 'Відкрити сповіщення' })).toBeVisible()
    await waitFor(() => expect(rowOf('У вас просять книжку')).not.toHaveTextContent('нове'))
    expect(rowOf('Ваше прохання погодили')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Прочитати всі' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Непрочитані' })).toBeVisible()
    expect(server.state.notifications).toHaveLength(3)
    expect(readAllCalls()).toBe(1)

    await user.click(screen.getByRole('button', { name: 'Непрочитані' }))

    expect(await screen.findByText('Непрочитаних немає.')).toBeVisible()
  })

  it('прочитаний запит у друзі не прийнято й не відхилено: в «Усіх» на нього досі можна відповісти', async () => {
    const user = userEvent.setup()

    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Прочитати всі' }))
    await waitFor(() => expect(rowOf('Новий запит у друзі')).not.toHaveTextContent('нове'))

    expect(server.state.incoming).toEqual([martaRequest])
    expect(server.count(`PATCH /friends/requests/${martaRequest.id}`)).toBe(0)

    const group = screen.getByRole('group', { name: `Запит у друзі від ${MARTA.displayName}` })

    await user.click(within(group).getByRole('button', { name: 'Прийняти' }))

    expect(await screen.findByText(/^Запит прийнято/)).toBeVisible()
    expect(server.count('PATCH /me/notifications/n-marta/read')).toBe(0)
  })

  it('«Прочитано» на одному рядку теж оновлює лічильник на дзвіночку', async () => {
    const user = userEvent.setup()

    renderScreen()
    await screen.findByText('У вас просять книжку')

    await user.click(
      within(rowOf('У вас просять книжку')).getByRole('button', { name: 'Прочитано' }),
    )

    expect(
      await screen.findByRole('button', { name: 'Відкрити сповіщення: 1 непрочитаних' }),
    ).toBeVisible()
  })

  it('під час запиту кнопка заблокована, і подвійний клік не надсилає другого запиту', async () => {
    const user = userEvent.setup()
    const release = server.holdNext('read-all')

    renderScreen()
    await user.dblClick(await screen.findByRole('button', { name: 'Прочитати всі' }))

    expect(screen.getByRole('button', { name: 'Позначаю…' })).toBeDisabled()

    release()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Прочитати всі' })).toBeDisabled(),
    )
    expect(readAllCalls()).toBe(1)
  })

  it('помилка показується, нічого не позначено, повторне натискання спрацьовує', async () => {
    const user = userEvent.setup()

    server.failNext('read-all', NETWORK_ERROR)
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Прочитати всі' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/^Не вдалося звʼязатися з API/)
    expect(server.state.notifications.filter((item) => item.readAt === null)).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Прочитати всі' }))

    expect(await screen.findByRole('button', { name: 'Відкрити сповіщення' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readAllCalls()).toBe(2)
  })
})

describe('NavBarNotifications: «Прочитати всі» з панелі (BS-127)', () => {
  async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(await screen.findByRole('button', { name: /^Відкрити сповіщення/ }))

    return screen.findByRole('dialog', { name: 'Сповіщення' })
  }

  it('фільтр «Непрочитані» у панелі показує лише сповіщення без readAt', async () => {
    const user = userEvent.setup()

    renderScreen()

    const panel = await openPanel(user)

    expect(await within(panel).findByText('Ваше прохання погодили')).toBeVisible()

    await user.click(within(panel).getByRole('button', { name: /^Непрочитані/ }))

    expect(await within(panel).findByText('У вас просять книжку')).toBeVisible()
    expect(within(panel).queryByText('Ваше прохання погодили')).not.toBeInTheDocument()
  })

  it('після успіху оновлюється і панель, і відкрита сторінка сповіщень', async () => {
    const user = userEvent.setup()

    renderScreen()

    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: 'Прочитати всі' }))

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Прочитати всі' })).toBeDisabled(),
    )
    expect(rowOf('Ваше прохання погодили', panel)).toBeVisible()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(rowOf('У вас просять книжку')).not.toHaveTextContent('нове'))
    expect(screen.getByRole('button', { name: 'Прочитати всі' })).toBeDisabled()
  })

  it('помилка показується в панелі, кнопка лишається для повтору', async () => {
    const user = userEvent.setup()

    server.failNext('read-all', NETWORK_ERROR)
    renderScreen()

    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: 'Прочитати всі' }))

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      /^Не вдалося звʼязатися з API/,
    )

    await user.click(within(panel).getByRole('button', { name: 'Прочитати всі' }))

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Прочитати всі' })).toBeDisabled(),
    )
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument()
    expect(readAllCalls()).toBe(2)
  })
})
