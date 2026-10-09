/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import NotificationsPage from './page'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const mockState: SessionState = {
  status: 'authenticated',
  user: {
    id: 'user-1',
    email: 'owner@example.com',
    emailVerified: true,
    displayName: 'Owner',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  features: { guestLoans: true },
}

jest.mock('../../lib/use-session', () => ({
  useSession: () => ({ state: mockState }),
}))

const NOTIFICATIONS = [
  {
    id: 'n-received',
    type: 'GUEST_LOAN_RECEIVED',
    payload: { loanId: 'loan-g1', copyId: 'copy-1', confirmationId: 'conf-1' },
    readAt: null,
    createdAt: '2026-09-29T10:00:00.000Z',
  },
  {
    id: 'n-denied',
    type: 'GUEST_LOAN_DENIED',
    payload: { loanId: 'loan-g2', copyId: 'copy-2', confirmationId: 'conf-2' },
    readAt: null,
    createdAt: '2026-09-29T11:00:00.000Z',
  },
  {
    id: 'n-loan',
    type: 'LOAN_REQUESTED',
    payload: { loanId: 'loan-r1', copyId: 'copy-3', actorId: 'user-2' },
    readAt: null,
    createdAt: '2026-09-29T12:00:00.000Z',
  },
]

jest.mock('../../lib/use-notifications', () => ({
  useNotifications: () => ({
    state: {
      status: 'ready',
      data: { notifications: NOTIFICATIONS, unreadCount: 3 },
    },
    reload: jest.fn(() => Promise.resolve()),
  }),
}))

const row = (text: string): HTMLElement => {
  const element = screen.getByText(text).closest('li')

  if (element === null) throw new Error(`Немає рядка «${text}»`)

  return element
}

describe('NotificationsPage: відповіді гостя (Stage 10, 10i.3)', () => {
  it('підписи двох нових типів без нікнейма/email; посилання веде до запиту підтвердження, а не до зареєстрованого позичання', () => {
    render(withQueryClient(<NotificationsPage />))

    const received = row('Гість підтвердив отримання книжки')
    const denied = row('Гість заперечує отримання книжки')

    expect(
      within(received).getByRole('link', { name: 'Відкрити запит підтвердження' }),
    ).toHaveAttribute('href', '/loans/guest?confirmationId=conf-1')
    expect(
      within(denied).getByRole('link', { name: 'Відкрити запит підтвердження' }),
    ).toHaveAttribute('href', '/loans/guest?confirmationId=conf-2')
    expect(
      within(received).queryByRole('link', { name: 'Відкрити позичання' }),
    ).not.toBeInTheDocument()
  })

  it('звичайні сповіщення про позики не зачеплені: посилання на /loans?loanId=', () => {
    render(withQueryClient(<NotificationsPage />))

    expect(
      within(row('У вас просять книжку')).getByRole('link', { name: 'Відкрити позичання' }),
    ).toHaveAttribute('href', '/loans?loanId=loan-r1')
  })
})
