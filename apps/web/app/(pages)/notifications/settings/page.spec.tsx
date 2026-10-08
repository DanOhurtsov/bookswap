/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { NOTIFICATION_TYPE, PREFERENCE_CHANNEL } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import NotificationSettingsPage from './page'

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
}

jest.mock('../../../lib/use-session', () => ({
  useSession: () => ({ state: mockState }),
}))

// Підключений Telegram і підтверджена пошта: усі колонки редаговані — тож заборона Telegram для відповідей гостя
// не може бути випадковим наслідком «канал недоступний».
const DATA = {
  preferences: NOTIFICATION_TYPE.flatMap((type) =>
    PREFERENCE_CHANNEL.map((channel) => ({
      type,
      channel,
      enabled:
        channel === 'IN_APP' ||
        (type.startsWith('GUEST_LOAN') ? channel === 'EMAIL' : channel === 'TELEGRAM'),
    })),
  ),
  channels: {
    inApp: { configured: true, connected: true, available: true },
    email: {
      address: 'owner@example.com',
      verified: true,
      configured: true,
      connected: true,
      available: true,
    },
    telegram: { configured: true, connected: true, available: true },
  },
}

jest.mock('../../../lib/use-notification-preferences', () => ({
  useNotificationPreferences: () => ({
    state: { status: 'ready', data: DATA },
    reload: jest.fn(() => Promise.resolve()),
  }),
}))

describe('NotificationSettingsPage: відповіді гостя (Stage 10, 10i.3)', () => {
  it.each(['Гість підтвердив отримання книжки', 'Гість заперечує отримання книжки'])(
    '«%s»: IN_APP і EMAIL керовані та ввімкнені за замовчуванням, TELEGRAM вимкнений і заблокований навіть з підключеним Telegram',
    (label) => {
      render(<NotificationSettingsPage />)

      const inApp = screen.getByLabelText(`${label} — У застосунку`)
      const email = screen.getByLabelText(`${label} — Пошта`)
      const telegram = screen.getByLabelText(`${label} — Telegram`)

      expect(inApp).toBeChecked()
      expect(inApp).toBeEnabled()
      expect(email).toBeEnabled()
      expect(telegram).not.toBeChecked()
      expect(telegram).toBeDisabled()
    },
  )

  it('пояснює загальний лист і відсутність Telegram; звичайні типи лишаються керованими', () => {
    render(<NotificationSettingsPage />)

    expect(screen.getAllByText(/лише загальне нагадування без подробиць/)).toHaveLength(2)
    expect(screen.getByLabelText('У вас просять книжку — Telegram')).toBeEnabled()
    expect(screen.getByLabelText('У вас просять книжку — Пошта')).toBeEnabled()
  })
})
