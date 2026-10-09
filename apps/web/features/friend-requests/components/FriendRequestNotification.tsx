'use client'

import type { FriendRequest, FriendRequestAction, Notification, PublicUser } from '@bookswap/shared'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import { Button } from '@/components/ui/button'
import type { ReadProgress } from '../model/friend-request-notification'
import type { FriendRequestActions } from '../model/use-friend-request-actions'

interface FriendRequestNotificationProps {
  notification: Notification
  actions: FriendRequestActions
}

/**
 * The answer part of one `FRIEND_REQUESTED` row — the same in the navbar panel and on
 * `/notifications`. Every button here is `type="button"` with no link around it: answering never
 * navigates and never closes the panel.
 */
export function FriendRequestNotification({
  notification,
  actions,
}: FriendRequestNotificationProps) {
  const view = actions.viewOf(notification)

  return (
    <div className="mt-2 w-full basis-full space-y-2 text-sm">
      {view.kind === 'checking' && <p className="text-muted-foreground">Перевіряю запит…</p>}

      {view.kind === 'check-failed' && (
        <div className="space-y-2" role="alert">
          <p className="text-destructive">Не вдалося перевірити запит: {view.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={actions.recheck}>
            Перевірити ще раз
          </Button>
        </div>
      )}

      {view.kind === 'inactive' && (
        <p className="text-muted-foreground">Запит більше не очікує відповіді.</p>
      )}

      {view.kind === 'refused' && (
        <p className="text-destructive" role="alert">
          Відповісти не вдалося: запит уже відкликали, обробили раніше або користувач недоступний.
        </p>
      )}

      {view.kind === 'answerable' && (
        <AnswerableRequest
          request={view.request}
          pendingAction={view.pendingAction}
          error={view.error}
          onRespond={(action) => actions.respond(notification, action)}
        />
      )}

      {view.kind === 'responded' && (
        <RespondedRequest
          action={view.action}
          user={view.user}
          read={view.read}
          onRetryRead={() => actions.retryMarkRead(notification)}
        />
      )}
    </div>
  )
}

interface AnswerableRequestProps {
  request: FriendRequest
  pendingAction: FriendRequestAction | null
  error: string | null
  onRespond: (action: FriendRequestAction) => void
}

function AnswerableRequest({ request, pendingAction, error, onRespond }: AnswerableRequestProps) {
  const pending = pendingAction !== null

  return (
    <div
      className="space-y-2"
      role="group"
      aria-label={`Запит у друзі від ${request.user.displayName}`}
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar user={request.user} />
        <p className="min-w-0 flex-1 truncate font-medium">{request.user.displayName}</p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => onRespond('accept')}>
            {pendingAction === 'accept' ? 'Приймаю…' : 'Прийняти'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onRespond('decline')}
          >
            {pendingAction === 'decline' ? 'Відхиляю…' : 'Відхилити'}
          </Button>
        </div>
      </div>

      {error !== null && (
        <div className="text-destructive" role="alert">
          <p>Не вдалося відповісти — спробуйте ще раз.</p>
          <p className="text-xs">{error}</p>
        </div>
      )}
    </div>
  )
}

interface RespondedRequestProps {
  action: FriendRequestAction
  user: PublicUser
  read: ReadProgress
  onRetryRead: () => void
}

function RespondedRequest({ action, user, read, onRetryRead }: RespondedRequestProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <UserAvatar user={user} />
        <p role="status">
          {action === 'accept'
            ? `Запит прийнято — тепер ви друзі з ${user.displayName}.`
            : `Запит від ${user.displayName} відхилено.`}
        </p>
      </div>

      {read === 'failed' && (
        <div className="space-y-2" role="alert">
          <p className="text-destructive">Не вдалося позначити сповіщення прочитаним.</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetryRead}>
            Позначити прочитаним ще раз
          </Button>
        </div>
      )}
    </div>
  )
}
