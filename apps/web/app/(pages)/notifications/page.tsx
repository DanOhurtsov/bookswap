'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { isGuestResponseNotificationType, type Notification } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../lib/api'
import { NOTIFICATION_TYPE_LABELS, formatDate } from '../../lib/labels'
import { useNotifications } from '../../lib/use-notifications'
import { useSession } from '../../lib/use-session'

/**
 * §7 і §8: центр in-app сповіщень.
 *
 * Канали назовні (email, Telegram) — етап 3: без диспетчера й `NotificationDelivery`
 * тут не було б чого показувати, крім вічного `PENDING`.
 */
export default function NotificationsPage() {
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  return <NotificationsScreen />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Сповіщення</h1>
      {children}
    </main>
  )
}

function NotificationsScreen() {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()

  const { state, reload } = useNotifications(unreadOnly)

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      // `await`: без нього рядок ще мить виглядав би непрочитаним.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
    }
  }

  const markRead = (id: string): Promise<void> =>
    run(`read:${id}`, async () => {
      await apiRequest(`/me/notifications/${id}/read`, { method: 'PATCH' })
    })

  const readAll = (): Promise<void> =>
    run('read-all', async () => {
      await apiRequest('/me/notifications/read-all', { method: 'POST' })
    })

  const unreadCount = state.status === 'ready' ? state.data.unreadCount : 0

  return (
    <Shell>
      <nav className="actions" aria-label="Вигляд сповіщень">
        <button
          type="button"
          className={unreadOnly ? 'button--ghost' : undefined}
          aria-pressed={!unreadOnly}
          onClick={() => {
            setUnreadOnly(false)
          }}
        >
          Усі
        </button>
        <button
          type="button"
          className={unreadOnly ? undefined : 'button--ghost'}
          aria-pressed={unreadOnly}
          onClick={() => {
            setUnreadOnly(true)
          }}
        >
          Непрочитані{unreadCount > 0 && <span className="badge badge--count">{unreadCount}</span>}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={busyKey !== undefined || unreadCount === 0}
          onClick={() => void readAll()}
        >
          {busyKey === 'read-all' ? 'Позначаю…' : 'Прочитати всі'}
        </button>
      </nav>

      <FormStatus error={failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.notifications.length === 0 && (
        <p className="empty">{unreadOnly ? 'Непрочитаних немає.' : 'Сповіщень поки немає.'}</p>
      )}

      {state.status === 'ready' && (
        <ul className="people">
          {state.data.notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              busyKey={busyKey}
              onRead={() => void markRead(notification.id)}
            />
          ))}
        </ul>
      )}

      <p className="form__aside">
        <Link href="/notifications/settings">Налаштування</Link> ·{' '}
        <Link href="/loans">Позичання</Link> · <Link href="/history">Історія</Link> ·{' '}
        <Link href="/library">Моя бібліотека</Link> · <Link href="/">На головну</Link>
      </p>
    </Shell>
  )
}

function NotificationRow({
  notification,
  busyKey,
  onRead,
}: {
  notification: Notification
  busyKey: string | undefined
  onRead: () => void
}) {
  const unread = notification.readAt === null
  // §4.8: payload — самі ідентифікатори, тож посилання будується з них, а не з
  // тексту сповіщення.
  const loanId = notification.payload.loanId
  // Stage 10 (10i.3): відповідь гостя веде до запиту підтвердження в гостьових позиках, а не до
  // зареєстрованого позичання; у payload лише id (жодного нікнейма/email гостя).
  const confirmationId = isGuestResponseNotificationType(notification.type)
    ? notification.payload.confirmationId
    : undefined

  return (
    <li className={unread ? 'person notification--unread' : 'person'}>
      <div className="person__who">
        <span className="person__name">{NOTIFICATION_TYPE_LABELS[notification.type]}</span>
        <span className="person__meta">
          {formatDate(notification.createdAt)}
          {unread && ' · нове'}
        </span>
      </div>

      <div className="person__actions">
        {/* §4.8: payload несе id — тож посилання веде до КОНКРЕТНОГО лоану, а
            не до списку, у якому його ще треба знайти. */}
        {confirmationId !== undefined ? (
          <Link href={`/loans/guest?confirmationId=${encodeURIComponent(confirmationId)}`}>
            Відкрити запит підтвердження
          </Link>
        ) : (
          loanId !== undefined && <Link href={`/loans?loanId=${loanId}`}>Відкрити позичання</Link>
        )}
        {unread && (
          <button
            type="button"
            className="button--ghost"
            disabled={busyKey !== undefined}
            onClick={onRead}
          >
            {busyKey === `read:${notification.id}` ? 'Позначаю…' : 'Прочитано'}
          </button>
        )}
      </div>
    </li>
  )
}
