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

type UserAvatarProps = {
  user: PublicUser
  /** The canvas pages (BS-154 `/friends`) draw initials on the person's pastel; elsewhere grey. */
  variant?: 'neutral' | 'pastel'
  className?: string
}

function UserAvatar({ user, variant = 'neutral', className }: UserAvatarProps) {
  const initials = getInitials(user.displayName)

  return (
    <Avatar size="lg" className={className}>
      {user.avatarUrl !== null && <AvatarImage src={user.avatarUrl} alt="" />}
      {variant === 'pastel' ? (
        <AvatarFallback variant="pastel" name={user.displayName}>
          {initials}
        </AvatarFallback>
      ) : (
        <AvatarFallback>{initials}</AvatarFallback>
      )}
    </Avatar>
  )
}

export { UserAvatar, getInitials }
