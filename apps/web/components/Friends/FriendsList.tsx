import Link from 'next/link'
import type { Friend, FriendRequest, PublicUser } from '@bookswap/shared'
import { ChevronDownIcon, SendIcon, UserRoundCheckIcon, UsersIcon } from 'lucide-react'
import { FriendRequestRow } from '@/components/Friends/FriendRequestRow'
import { FriendRow } from '@/components/Friends/FriendRow'
import { USER_SEARCH_PATH } from '@/features/user-search/index.client'

interface FriendsListProps {
  friends: Friend[]
  incoming: FriendRequest[]
  outgoing: FriendRequest[]
  busyKey: string | undefined
  onRespond: (requestId: string, action: 'accept' | 'decline') => void
  onCancelRequest: (request: FriendRequest) => void
  onRemoveFriend: (friend: PublicUser) => void
  onBlockFriend: (friend: PublicUser) => void
}

function FriendsList({
  friends,
  incoming,
  outgoing,
  busyKey,
  onRespond,
  onCancelRequest,
  onRemoveFriend,
  onBlockFriend,
}: FriendsListProps) {
  return (
    <div className="space-y-6">
      {incoming.length > 0 && (
        <section aria-labelledby="incoming-requests-title">
          <div className="mb-2 flex items-center gap-2">
            <UserRoundCheckIcon
              className="size-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <h2 id="incoming-requests-title" className="text-sm font-semibold">
              Нові запити
            </h2>
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              {incoming.length}
            </span>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card text-card-foreground">
            {incoming.map((request) => (
              <FriendRequestRow
                key={request.id}
                request={request}
                direction="incoming"
                busyKey={busyKey}
                onAccept={() => onRespond(request.id, 'accept')}
                onDecline={() => onRespond(request.id, 'decline')}
              />
            ))}
          </ul>
        </section>
      )}

      {outgoing.length > 0 && (
        <details className="group overflow-hidden rounded-xl border bg-card text-card-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
            <SendIcon className="size-4" aria-hidden="true" />
            Надіслані запити
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{outgoing.length}</span>
            <ChevronDownIcon
              className="ml-auto size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <ul className="divide-y border-t">
            {outgoing.map((request) => (
              <FriendRequestRow
                key={request.id}
                request={request}
                direction="outgoing"
                busyKey={busyKey}
                onCancel={() => onCancelRequest(request)}
              />
            ))}
          </ul>
        </details>
      )}

      <section aria-labelledby="friends-list-title">
        <div className="mb-2 flex items-center gap-2">
          <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 id="friends-list-title" className="text-sm font-semibold">
            Усі друзі
          </h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {friends.length}
          </span>
        </div>

        {friends.length === 0 ? (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <UsersIcon
              className="mx-auto mb-3 size-8 text-muted-foreground/60"
              aria-hidden="true"
            />
            <p className="font-medium">Тут поки нікого</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {/* Stands out from the muted sentence before hover; focus keeps the global ring. */}
              <Link href={USER_SEARCH_PATH} className="link-underline font-medium text-foreground">
                Знайдіть людину
              </Link>{' '}
              й надішліть запит у друзі.
            </p>
          </div>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card text-card-foreground">
            {friends.map((friend) => (
              <FriendRow
                key={friend.user.id}
                friend={friend}
                busy={busyKey !== undefined}
                onRemove={() => onRemoveFriend(friend.user)}
                onBlock={() => onBlockFriend(friend.user)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export { FriendsList }
