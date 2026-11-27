import Link from 'next/link'
import { useRef } from 'react'
import type { Friend } from '@bookswap/shared'
import { BanIcon, EllipsisIcon, UserMinusIcon } from 'lucide-react'
import { formatDate } from '@/app/lib/labels'
import { personHref } from '@/app/lib/person-href'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface FriendRowProps {
  friend: Friend
  busy: boolean
  /** Each gets «⋯»: the focus goes back there when the confirmation closes. */
  onRemove: (menuTrigger: HTMLElement | null) => void
  onBlock: (menuTrigger: HTMLElement | null) => void
}

/**
 * One friend as the canvas card draws it: the whole card opens the friend's library (the name link
 * stretches over it), only «⋯» is a control of its own. The canvas's books, mutual friends and loan
 * status are not in `GET /friends` (BS-154 report), so the card says since when you are friends.
 */
function FriendRow({ friend, busy, onRemove, onBlock }: FriendRowProps) {
  const { user } = friend
  const trigger = useRef<HTMLButtonElement>(null)

  return (
    <li className="friend-card">
      <UserAvatar user={user} variant="pastel" className="friend-card__avatar" />
      <div className="friend-card__who">
        <Link href={personHref(user)} className="friend-card__name">
          {user.displayName}
        </Link>
        <span className="friend-card__handle">@{user.handle}</span>
      </div>
      <span className="friend-card__since">Друзі з {formatDate(friend.friendsSince)}</span>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              ref={trigger}
              type="button"
              className="friend-card__menu"
              disabled={busy}
              aria-label={`Дії з другом ${user.displayName}`}
            >
              <EllipsisIcon aria-hidden="true" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">{user.displayName}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={busy}
              onClick={() => {
                onRemove(trigger.current)
              }}
            >
              <UserMinusIcon aria-hidden="true" />
              Видалити з друзів
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onClick={() => {
                onBlock(trigger.current)
              }}
            >
              <BanIcon aria-hidden="true" />
              Заблокувати
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export { FriendRow }
