import Link from 'next/link'
import type { FriendRelation, UserSearchResult } from '@bookswap/shared'
import { UserPlusIcon } from 'lucide-react'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import { Button } from '@/components/ui/button'
import type { FoundUserActions } from '../model/use-found-user-actions'

const RELATION_LABELS: Record<FriendRelation, string> = {
  NONE: 'Ще не друзі',
  REQUEST_SENT: 'Запит надіслано — чекає на відповідь',
  REQUEST_RECEIVED: 'Надіслав(-ла) вам запит',
  FRIENDS: 'Уже друзі',
  BLOCKED_BY_ME: 'Ви заблокували цю людину',
  BLOCKED_ME: 'Ця людина вас заблокувала',
}

/** A blocked pair cannot see each other's library: no link to a page that would refuse. */
const LINKED_RELATIONS: ReadonlySet<FriendRelation> = new Set([
  'NONE',
  'REQUEST_SENT',
  'REQUEST_RECEIVED',
  'FRIENDS',
])

type FoundUserListProps = {
  results: readonly UserSearchResult[]
  actions: FoundUserActions
  /** A link was followed — the header panel closes. */
  onNavigate?: () => void
}

/** Found people with their relation and action: the same rows in the header panel and the page. */
export function FoundUserList({ results, actions, onNavigate }: FoundUserListProps) {
  return (
    <ul className="divide-y" aria-label="Знайдені люди">
      {results.map((result) => (
        <FoundUserRow
          key={result.user.id}
          result={result}
          actions={actions}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  )
}

type FoundUserRowProps = {
  result: UserSearchResult
  actions: FoundUserActions
  onNavigate: (() => void) | undefined
}

function FoundUserRow({ result, actions, onNavigate }: FoundUserRowProps) {
  const { user, relation } = result
  const acceptFailed =
    relation === 'REQUEST_RECEIVED' && actions.acceptStateOf(user.id).status === 'failed'

  return (
    <li className="flex items-center gap-3 px-2 py-2">
      <UserAvatar user={user} />
      <div className="min-w-0 flex-1">
        {LINKED_RELATIONS.has(relation) ? (
          <Link
            href={`/users/${encodeURIComponent(user.id)}/library`}
            className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={onNavigate}
          >
            {user.displayName}
          </Link>
        ) : (
          <p className="truncate font-medium">{user.displayName}</p>
        )}
        <p className="truncate text-xs text-muted-foreground">{RELATION_LABELS[relation]}</p>
        {acceptFailed && (
          <p className="text-xs text-destructive" role="alert">
            Не вдалося завантажити запит у друзі.
          </p>
        )}
      </div>
      <RelationAction result={result} actions={actions} />
    </li>
  )
}

function RelationAction({ result, actions }: Omit<FoundUserRowProps, 'onNavigate'>) {
  const { user, relation } = result
  const busy = actions.pending.length > 0
  const pendingHere = actions.pending.some((action) => action.userId === user.id)

  switch (relation) {
    case 'NONE':
      return (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => actions.run({ kind: 'request', userId: user.id })}
        >
          <UserPlusIcon aria-hidden="true" />
          {pendingHere ? 'Надсилаю…' : 'Додати'}
        </Button>
      )
    case 'REQUEST_RECEIVED':
      return <AcceptAction userId={user.id} actions={actions} busy={busy} />
    case 'BLOCKED_BY_ME':
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => actions.run({ kind: 'unblock', userId: user.id })}
        >
          {pendingHere ? 'Знімаю…' : 'Розблокувати'}
        </Button>
      )
    case 'REQUEST_SENT':
    case 'FRIENDS':
    case 'BLOCKED_ME':
      return null
  }
}

type AcceptActionProps = { userId: string; actions: FoundUserActions; busy: boolean }

/** «Прийняти» answers a friendship row whose id comes from `GET /friends/requests`. */
function AcceptAction({ userId, actions, busy }: AcceptActionProps) {
  const state = actions.acceptStateOf(userId)

  switch (state.status) {
    case 'loading':
      return (
        <Button type="button" size="sm" disabled>
          Перевіряю…
        </Button>
      )
    case 'failed':
      return (
        <Button type="button" variant="outline" size="sm" onClick={actions.retryAccept}>
          Повторити
        </Button>
      )
    case 'ready':
      return (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => actions.run({ kind: 'accept', userId, requestId: state.requestId })}
        >
          Прийняти
        </Button>
      )
    case 'unavailable':
      return null
  }
}
