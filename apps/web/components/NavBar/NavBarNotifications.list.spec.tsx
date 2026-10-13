/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Notification } from '@bookswap/shared'
import { withQueryClient } from '@/app/lib/test-query-client'
import {
  MARTA,
  NETWORK_ERROR,
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

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const martaRequest = pendingRequest(MARTA, 'friendship-marta')

const LOAN_REQUESTED: Notification = {
  id: 'n-loan',
  type: 'LOAN_REQUESTED',
  payload: { loanId: 'loan-1', copyId: 'copy-1', actorId: 'user-2' },
  readAt: null,
  createdAt: '2026-10-03T10:00:00.000Z',
}

const LOAN_APPROVED_READ: Notification = {
  id: 'n-approved',
  type: 'LOAN_APPROVED',
  payload: { loanId: 'loan-2', copyId: 'copy-2', actorId: 'user-2' },
  readAt: '2026-10-02T12:00:00.000Z',
  createdAt: '2026-10-02T11:00:00.000Z',
}

const LOAN_RETURNED: Notification = {
  id: 'n-returned',
  type: 'LOAN_RETURNED',
  payload: { loanId: 'loan-3', copyId: 'copy-3', actorId: 'user-2' },
  readAt: null,
  createdAt: '2026-09-30T10:00:00.000Z',
}

/** API order (`createdAt DESC`): unread, read and unread rows interleaved. */
const API_ORDER = ['У вас просять книжку', 'Ваше прохання погодили', 'Новий запит у друзі']
const MIXED = [LOAN_REQUESTED, LOAN_APPROVED_READ, friendRequested('n-marta', martaRequest)]

const UNREAD_ACCENT = 'border-l-(--bookswap-accent)'

let server: FakeServer

function serve(notifications: Notification[] = MIXED): void {
  server = createFakeServer({ notifications, incoming: [martaRequest] })
  apiRequest.mockImplementation(server.handle)
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(withQueryClient(<NavBarNotifications />))

  await user.click(await screen.findByRole('button', { name: /^Відкрити сповіщення/ }))

  const panel = await screen.findByRole('dialog', { name: 'Сповіщення' })

  await within(panel).findByRole('list')

  return panel
}

/** The panel's rows, top to bottom. */
function rows(panel: HTMLElement): HTMLElement[] {
  return Array.from(within(panel).getByRole('list').children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  )
}

function rowOf(panel: HTMLElement, label: string): HTMLElement {
  const row = rows(panel).find((item) => within(item).queryByText(label) !== null)

  if (row === undefined) throw new Error(`Немає рядка «${label}»`)

  return row
}

function expectUnread(row: HTMLElement): void {
  expect(row).toHaveClass(UNREAD_ACCENT)
  expect(row).toHaveTextContent('нове')
}

function expectRead(row: HTMLElement): void {
  expect(row).not.toHaveClass(UNREAD_ACCENT)
  expect(row).not.toHaveTextContent('нове')
}

function expectApiOrder(panel: HTMLElement): void {
  const items = rows(panel)

  expect(items).toHaveLength(API_ORDER.length)
  API_ORDER.forEach((label, index) => expect(items[index]).toHaveTextContent(label))
}

/** The bell stays behind the modal panel, so it is outside the accessibility tree while open. */
function bell(name: string): HTMLElement {
  return screen.getByRole('button', { name, hidden: true })
}

beforeEach(() => {
  apiRequest.mockReset()
  serve()
})

describe('NavBarNotifications: один список без фільтрів (BS-131)', () => {
  it('у панелі немає вкладок і входів у налаштування; «Усі сповіщення» веде на /notifications', async () => {
    const user = userEvent.setup()
    const panel = await openPanel(user)

    expect(within(panel).queryByRole('button', { name: /^Усі/ })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /^Непрочитані/ })).not.toBeInTheDocument()
    expect(within(panel).queryByText(/Непрочитан/)).not.toBeInTheDocument()
    expect(within(panel).queryByText(/Налаштування/)).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: /Налаштування/ })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Налаштування/ })).not.toBeInTheDocument()
    expect(
      within(panel)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/notifications/settings')),
    ).toEqual([])
    expect(within(panel).getByRole('link', { name: 'Усі сповіщення' })).toHaveAttribute(
      'href',
      '/notifications',
    )
  })

  it('запитує загальний список і показує прочитані й непрочитані в порядку API', async () => {
    const user = userEvent.setup()
    const panel = await openPanel(user)

    expectApiOrder(panel)
    expect(server.count('GET /me/notifications')).toBeGreaterThan(0)
    expect(server.count('GET /me/notifications?unread=true')).toBe(0)

    expectUnread(rowOf(panel, 'У вас просять книжку'))
    expectRead(rowOf(panel, 'Ваше прохання погодили'))
    expectUnread(rowOf(panel, 'Новий запит у друзі'))
    expect(bell('Відкрити сповіщення: 2 непрочитаних')).toBeInTheDocument()
  })

  it('лічильник на дзвіночку — unreadCount з API, а не довжина списку', async () => {
    const user = userEvent.setup()

    serve([LOAN_REQUESTED, LOAN_APPROVED_READ, LOAN_RETURNED])

    const panel = await openPanel(user)

    expect(rows(panel)).toHaveLength(3)
    expect(bell('Відкрити сповіщення: 2 непрочитаних')).toBeInTheDocument()
  })

  it('«Прочитано» знімає зелений акцент лише з цього рядка; рядки й порядок лишаються', async () => {
    const user = userEvent.setup()
    const panel = await openPanel(user)

    await user.click(
      within(rowOf(panel, 'У вас просять книжку')).getByRole('button', { name: 'Прочитано' }),
    )

    await waitFor(() => expectRead(rowOf(panel, 'У вас просять книжку')))
    expectApiOrder(panel)
    expectUnread(rowOf(panel, 'Новий запит у друзі'))
    expect(bell('Відкрити сповіщення: 1 непрочитаних')).toBeInTheDocument()
    expect(server.count('PATCH /me/notifications/n-loan/read')).toBe(1)
    // Reading a friend request notification is not an answer to it.
    expect(server.state.incoming).toEqual([martaRequest])
  })

  it('«Прочитати всі» знімає акцент з усіх рядків, нічого не прибираючи зі списку', async () => {
    const user = userEvent.setup()
    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: 'Прочитати всі' }))

    await waitFor(() => rows(panel).forEach(expectRead))
    expectApiOrder(panel)
    expect(within(panel).getByRole('button', { name: 'Прочитати всі' })).toBeDisabled()
    expect(bell('Відкрити сповіщення')).toBeInTheDocument()
    expect(server.count('POST /me/notifications/read-all')).toBe(1)
  })

  it('помилка прочитання зберігає акцент і «нове»; повтор спрацьовує', async () => {
    const user = userEvent.setup()
    const panel = await openPanel(user)

    server.failNext('read', NETWORK_ERROR)
    await user.click(
      within(rowOf(panel, 'У вас просять книжку')).getByRole('button', { name: 'Прочитано' }),
    )

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      /^Не вдалося звʼязатися з API/,
    )
    expectUnread(rowOf(panel, 'У вас просять книжку'))
    expect(bell('Відкрити сповіщення: 2 непрочитаних')).toBeInTheDocument()

    await user.click(
      within(rowOf(panel, 'У вас просять книжку')).getByRole('button', { name: 'Прочитано' }),
    )

    await waitFor(() => expectRead(rowOf(panel, 'У вас просять книжку')))
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument()
    expectApiOrder(panel)
    expect(server.count('PATCH /me/notifications/n-loan/read')).toBe(2)
  })

  it('порожня відповідь — загальний empty-стан', async () => {
    const user = userEvent.setup()

    serve([])
    render(withQueryClient(<NavBarNotifications />))
    await user.click(await screen.findByRole('button', { name: 'Відкрити сповіщення' }))

    const panel = await screen.findByRole('dialog', { name: 'Сповіщення' })

    expect(await within(panel).findByText('Сповіщень поки немає.')).toBeVisible()
    expect(within(panel).getByRole('button', { name: 'Прочитати всі' })).toBeDisabled()
  })
})
