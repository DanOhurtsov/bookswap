'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { Notification } from '@bookswap/shared'
import { BellIcon, CheckCheckIcon, SettingsIcon } from 'lucide-react'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { NOTIFICATION_TYPE_LABELS, formatDate } from '@/app/lib/labels'
import {
  markAllNotificationsRead,
  markNotificationRead,
  useNotifications,
} from '@/app/lib/use-notifications'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  FriendRequestNotification,
  useFriendRequestActions,
  type FriendRequestActions,
} from '@/features/friend-requests/index.client'

export const NavBarNotifications = () => {
  const [open, setOpen] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const notifications = useNotifications(unreadOnly)

  const unreadCount =
    notifications.state.status === 'ready' ? notifications.state.data.unreadCount : 0

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={
              unreadCount > 0
                ? `Відкрити сповіщення: ${unreadCount} непрочитаних`
                : 'Відкрити сповіщення'
            }
          >
            <BellIcon aria-hidden="true" />
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] leading-4 font-semibold text-white"
                aria-hidden="true"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </Button>
        }
      />

      {open && (
        <NotificationsPanel
          resource={notifications}
          unreadOnly={unreadOnly}
          onUnreadOnlyChange={setUnreadOnly}
          onNavigate={() => setOpen(false)}
        />
      )}
    </Sheet>
  )
}

function NotificationsPanel({
  resource,
  unreadOnly,
  onUnreadOnlyChange,
  onNavigate,
}: {
  resource: ReturnType<typeof useNotifications>
  unreadOnly: boolean
  onUnreadOnlyChange: (value: boolean) => void
  onNavigate: () => void
}) {
  const [busyKey, setBusyKey] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const unreadCount = resource.state.status === 'ready' ? resource.state.data.unreadCount : 0
  const friendRequests = useFriendRequestActions(
    resource.state.status === 'ready' ? resource.state.data.notifications : undefined,
  )

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      await resource.reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error.message : describeError(error))
    } finally {
      setBusyKey(undefined)
    }
  }

  function markRead(id: string): void {
    void run(`read:${id}`, () => markNotificationRead(id))
  }

  function readAll(): void {
    void run('read-all', markAllNotificationsRead)
  }

  return (
    <SheetContent className="dark w-full gap-0 sm:max-w-md">
      <SheetHeader className="border-b pr-14">
        <div className="flex items-start justify-between gap-3">
          <div>
            <SheetTitle>Сповіщення</SheetTitle>
            <SheetDescription>Новини про позичання, друзів і вашу бібліотеку.</SheetDescription>
          </div>

          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
            aria-label="Налаштування сповіщень"
            render={<Link href="/notifications/settings" onClick={onNavigate} />}
          >
            <SettingsIcon aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-2" aria-label="Вигляд сповіщень">
          <Button
            type="button"
            size="sm"
            variant={unreadOnly ? 'ghost' : 'secondary'}
            aria-pressed={!unreadOnly}
            onClick={() => onUnreadOnlyChange(false)}
          >
            Усі
          </Button>
          <Button
            type="button"
            size="sm"
            variant={unreadOnly ? 'secondary' : 'ghost'}
            aria-pressed={unreadOnly}
            onClick={() => onUnreadOnlyChange(true)}
          >
            Непрочитані{unreadCount > 0 && ` (${unreadCount})`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busyKey !== undefined || unreadCount === 0}
            onClick={readAll}
          >
            <CheckCheckIcon aria-hidden="true" />
            {busyKey === 'read-all' ? 'Позначаю…' : 'Прочитати всі'}
          </Button>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {failure !== undefined && (
          <p
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
            role="alert"
          >
            {failure}
          </p>
        )}

        {resource.state.status === 'loading' && <NotificationsSkeleton />}

        {resource.state.status === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-destructive" role="alert">
              {resource.state.message}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => resource.reload()}>
              Спробувати ще раз
            </Button>
          </div>
        )}

        {resource.state.status === 'ready' && resource.state.data.notifications.length === 0 && (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {unreadOnly ? 'Непрочитаних сповіщень немає.' : 'Сповіщень поки немає.'}
          </p>
        )}

        {resource.state.status === 'ready' && resource.state.data.notifications.length > 0 && (
          <ul className="space-y-2">
            {resource.state.data.notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                busy={busyKey !== undefined}
                markingRead={busyKey === `read:${notification.id}`}
                friendRequests={friendRequests}
                onRead={() => markRead(notification.id)}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t p-4 text-sm font-medium">
        <Link href="/notifications" onClick={onNavigate}>
          Усі сповіщення
        </Link>
        <Link href="/notifications/settings" onClick={onNavigate}>
          Налаштування
        </Link>
      </div>
    </SheetContent>
  )
}

function NotificationRow({
  notification,
  busy,
  markingRead,
  friendRequests,
  onRead,
  onNavigate,
}: {
  notification: Notification
  busy: boolean
  markingRead: boolean
  friendRequests: FriendRequestActions
  onRead: () => void
  onNavigate: () => void
}) {
  const unread = notification.readAt === null
  const loanId = notification.payload.loanId

  return (
    <li
      className={`rounded-lg border p-3 ${unread ? 'border-l-3 border-l-primary bg-muted/40' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{NOTIFICATION_TYPE_LABELS[notification.type]}</p>
          <p className="text-xs text-muted-foreground">
            {formatDate(notification.createdAt)}
            {unread && ' · нове'}
          </p>
        </div>

        {unread && (
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onRead}>
            {markingRead ? 'Позначаю…' : 'Прочитано'}
          </Button>
        )}
      </div>

      {notification.type === 'FRIEND_REQUESTED' && (
        <FriendRequestNotification notification={notification} actions={friendRequests} />
      )}

      {loanId !== undefined && (
        <Link
          href={`/loans?loanId=${loanId}`}
          className="mt-2 inline-block text-xs font-medium"
          onClick={onNavigate}
        >
          Відкрити позичання
        </Link>
      )}
    </li>
  )
}

function NotificationsSkeleton() {
  return (
    <div className="space-y-3" aria-label="Завантажую сповіщення">
      {[0, 1, 2].map((item) => (
        <div key={item} className="space-y-2 rounded-lg border p-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  )
}
