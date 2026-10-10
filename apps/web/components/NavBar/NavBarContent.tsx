import Link from 'next/link'
import type { Me, SessionFeatures } from '@bookswap/shared'
import { type SessionState } from '@/app/lib/use-session'
import { NAVBAR_LINK_CONTACTS, NAVBAR_LINKS_AUTH, NAVBAR_LINKS_GUEST } from '@/constants/navigation'
import { NavBarAvatar } from '@/components/NavBar/NavBarAvatar'
import { NavBarLogo } from '@/components/NavBar/NavBarLogo'
import { NavBarMenu } from '@/components/NavBar/NavBarMenu'
import { NavBarNotifications } from '@/components/NavBar/NavBarNotifications'
import { ThemeToggleButton } from '@/components/ThemeToggle'

const NavContent = ({ state }: { state: SessionState }) => {
  switch (state.status) {
    case 'loading':
      return (
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <NavSkeleton />
          <ThemeToggleButton />
        </div>
      )

    case 'authenticated':
      return <AuthNav user={state.user} features={state.features} />

    case 'guest':
    case 'error':
      return <GuestNav />
  }
}

// AuthNav
const AuthNav = ({ user, features }: { user: Me; features?: SessionFeatures }) => {
  const links =
    features?.guestLoans === true ? [...NAVBAR_LINKS_AUTH, NAVBAR_LINK_CONTACTS] : NAVBAR_LINKS_AUTH

  return (
    <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
      <div className="flex items-center gap-2">
        <NavBarMenu links={links} className="lg:hidden" />
        <NavBarLogo />
      </div>
      {/* Below `lg` the inline row no longer fits next to the logo and the account controls. */}
      <nav className="hidden items-center gap-4 lg:flex">
        {links.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center gap-2">
        <NavBarNotifications />
        <NavBarAvatar user={user} />
      </div>
    </div>
  )
}

// GuestNav
const GuestNav = () => {
  return (
    <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
      <NavBarLogo />
      <div className="flex items-center gap-2">
        <nav className="flex items-center gap-4">
          {NAVBAR_LINKS_GUEST.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <ThemeToggleButton />
      </div>
    </div>
  )
}

// NavSkeleton
const NavSkeleton = () => (
  <div className="flex items-center gap-4 animate-pulse" aria-hidden="true">
    <div className="h-5 w-16 rounded bg-(--line)" />
    <div className="h-5 w-20 rounded bg-(--line)" />
    <div className="h-5 w-24 rounded bg-(--line)" />
    <div className="h-5 w-20 rounded bg-(--line)" />
  </div>
)

export { NavContent }
