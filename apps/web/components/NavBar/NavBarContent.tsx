import Link from 'next/link'
import type { Me, SessionFeatures } from '@bookswap/shared'
import { type SessionState } from '@/app/lib/use-session'
import { NAVBAR_LINK_CONTACTS, NAVBAR_LINKS_AUTH, NAVBAR_LINKS_GUEST } from '@/constants/navigation'
import { NavBarAvatar } from '@/components/NavBar/NavBarAvatar'
import { NavBarLogo } from '@/components/NavBar/NavBarLogo'
import { NavBarMenu } from '@/components/NavBar/NavBarMenu'
import { NavBarNotifications } from '@/components/NavBar/NavBarNotifications'
import { ThemeToggleButton } from '@/components/ThemeToggle'
import { UserSearch } from '@/features/user-search/index.client'

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
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex items-center gap-2">
        <NavBarMenu links={links} className="xl:hidden" />
        <NavBarLogo />
      </div>
      {/* Below `xl` the inline row no longer fits next to the logo, the people search and the
          account controls. */}
      <nav className="hidden items-center gap-4 xl:flex">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="link-underline">
            {link.label}
          </Link>
        ))}
      </nav>
      {/* One instance on every width: below `md` it wraps into its own row. Keyed by the person,
          so another account never sees the previous one's text or results. */}
      <UserSearch
        key={user.id}
        viewerId={user.id}
        className="order-last w-full md:order-none md:w-auto md:max-w-sm md:flex-1"
      />
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
            <Link key={link.href} href={link.href} className="link-underline">
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
