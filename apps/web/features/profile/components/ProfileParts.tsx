import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import type { PublicUser } from '@bookswap/shared'
import { ArrowRight } from 'lucide-react'
import { getInitials } from '@/components/Friends/UserAvatar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/** The white card the profile is built of (canvas «Profile Page»). */
export const PROFILE_CARD =
  'rounded-xl border border-(--line) bg-(--field-bg) shadow-[0_1px_2px_rgba(20,28,24,.04),0_2px_8px_rgba(20,28,24,.04)]'

/** The profile's action button (canvas `.btn`): 44 px, 15 px semibold. */
export const PROFILE_ACTION = 'h-11 gap-2 px-[18px] text-[15px] font-semibold'

/**
 * The profile's call to action (canvas `.btn-primary`): the brand colour, not the app's dark default
 * (PO decision, 28.10.2026). Saturated green with white text in both themes — the dark theme's light
 * accent is for links and icons only.
 */
export const PROFILE_CTA = `${PROFILE_ACTION} bg-(--profile-cta-bg) text-(--profile-on-cta) hover:bg-(--profile-cta-hover) active:bg-(--profile-cta-hover)`

/**
 * An action that is only an icon (the profile card's «Редагувати профіль», «Запросити друзів»): a
 * 44 px target, the accent icon, a tint on hover and press, the focus ring and a dimmed disabled look.
 */
export const PROFILE_ICON_ACTION =
  'size-11 rounded-lg text-(--profile-accent) hover:bg-(--profile-accent-subtle) hover:text-(--profile-accent-hover) active:bg-(--profile-accent-subtle) aria-disabled:cursor-default aria-disabled:opacity-80 focus-visible:ring-(--profile-accent)/50 [&_svg:not([class*=size-])]:size-5'

/** A card that is a section of its own, named by its heading or `aria-label`. */
export function ProfileCard({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn(PROFILE_CARD, className)} {...props} />
}

/** «Усі 86 →»: a section's way to the full list. */
export function SeeAllLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group/see inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 text-[15px] whitespace-nowrap font-semibold text-(--bookswap-accent) no-underline"
    >
      {children}
      <ArrowRight
        aria-hidden="true"
        className="size-[18px] transition-transform group-hover/see:translate-x-0.5"
      />
    </Link>
  )
}

/** A section with nothing in it yet: what will appear here, and the one step that fills it. */
export function EmptySection({
  title,
  text,
  action,
}: {
  title: string
  text: string
  action: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-1 px-1 py-2">
      <p className="m-0 text-[15px] leading-[22px] font-semibold">{title}</p>
      <p className="m-0 text-sm leading-5 text-(--bookswap-muted)">{text}</p>
      <div className="mt-1">{action}</div>
    </div>
  )
}

/**
 * A person's photo at any size, initials while there is none. `UserAvatar` is fixed at 40 px; the
 * profile needs 96 px for the owner and 48 px for friends. Always beside the name, so it is hidden
 * from assistive technology: initials would only repeat the name, badly.
 */
export function ProfileAvatar({
  user,
  className,
  fallbackClassName,
}: {
  user: Pick<PublicUser, 'displayName' | 'avatarUrl'>
  className: string
  fallbackClassName: string
}) {
  return (
    <Avatar aria-hidden="true" className={className}>
      {user.avatarUrl !== null && <AvatarImage src={user.avatarUrl} alt="" />}
      <AvatarFallback
        className={cn(
          'bg-(--profile-accent-subtle) font-semibold text-(--profile-accent)',
          fallbackClassName,
        )}
      >
        {getInitials(user.displayName)}
      </AvatarFallback>
    </Avatar>
  )
}
