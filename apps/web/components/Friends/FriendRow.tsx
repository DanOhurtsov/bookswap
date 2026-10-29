import Link from 'next/link'
import type { Friend } from '@bookswap/shared'
import { BanIcon, BookOpenIcon, EllipsisVerticalIcon, UserMinusIcon } from 'lucide-react'
import { formatDate } from '@/app/lib/labels'
import { personHref } from '@/app/lib/person-href'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import { Button } from '@/components/ui/button'
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
  onRemove: () => void
  onBlock: () => void
}

function FriendRow({ friend, busy, onRemove, onBlock }: FriendRowProps) {
  const libraryHref = personHref(friend.user)

  return (
    <li className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/50 sm:px-4">
      <Link
        href={libraryHref}
        className="flex min-w-0 flex-1 items-center gap-3 text-inherit no-underline"
      >
        <UserAvatar user={friend.user} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{friend.user.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">
            Друзі з {formatDate(friend.friendsSince)}
          </span>
        </span>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={`Дії з другом ${friend.user.displayName}`}
            >
              <EllipsisVerticalIcon aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">{friend.user.displayName}</DropdownMenuLabel>
            <DropdownMenuItem render={<Link href={libraryHref} />}>
              <BookOpenIcon aria-hidden="true" />
              Відкрити бібліотеку
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onClick={onRemove}>
              <UserMinusIcon aria-hidden="true" />
              Видалити з друзів
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={busy} onClick={onBlock}>
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
