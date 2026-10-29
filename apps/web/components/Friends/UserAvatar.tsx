import type { PublicUser } from '@bookswap/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

function getInitials(displayName: string): string {
  return (
    displayName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .toLocaleUpperCase('uk-UA') || '?'
  )
}

function UserAvatar({ user }: { user: PublicUser }) {
  return (
    <Avatar size="lg">
      {user.avatarUrl !== null && <AvatarImage src={user.avatarUrl} alt="" />}
      <AvatarFallback>{getInitials(user.displayName)}</AvatarFallback>
    </Avatar>
  )
}

export { UserAvatar, getInitials }
