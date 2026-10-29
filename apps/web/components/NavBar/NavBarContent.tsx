import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Me, SessionFeatures } from '@bookswap/shared'
import { type SessionState } from '@/app/lib/use-session'
import {
  NAVBAR_LINK_CONTACTS,
  NAVBAR_LINK_FRIENDS,
  NAVBAR_LINK_LIBRARY,
  NAVBAR_LINKS_AUTH,
  NAVBAR_LINKS_GUEST,
} from '@/constants/navigation'
import { NavBarAvatar } from '@/components/NavBar/NavBarAvatar'
import { NavBarLogo } from '@/components/NavBar/NavBarLogo'
import { NavBarMenu } from '@/components/NavBar/NavBarMenu'
import { NavBarNotifications } from '@/components/NavBar/NavBarNotifications'
import { ThemeToggleButton } from '@/components/ThemeToggle'
import { currentLibrarySection } from '@/features/library/sections'

const NavContent = ({ state }: { state: SessionState }) => {
  switch (state.status) {
    case 'loading':
      return (
        <div className="flex w-full items-center justify-between">
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

/**
 * The header entry the pathname belongs to, the same one for the inline row and the compact menu.
 * Only the entries that stand for a whole area have a current state: «Моя бібліотека» for its
 * sections (someone else's library at `/u/:handle` is not one of them) and «Друзі» for
 * `/friends` and the pages under it. Matching is by whole path segments, so `/friends-other` is not
 * «Друзі».
 */
function currentNavHref(pathname: string): string | undefined {
  if (currentLibrarySection(pathname) !== undefined) return NAVBAR_LINK_LIBRARY.href

  const friends = NAVBAR_LINK_FRIENDS.href
  if (pathname === friends || pathname.startsWith(`${friends}/`)) return friends

  return undefined
}

// AuthNav
const AuthNav = ({ user, features }: { user: Me; features?: SessionFeatures }) => {
  const links =
    features?.guestLoans === true ? [...NAVBAR_LINKS_AUTH, NAVBAR_LINK_CONTACTS] : NAVBAR_LINKS_AUTH
  const currentHref = currentNavHref(usePathname())

  return (
    <div className="flex w-full items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <NavBarMenu links={links} currentHref={currentHref} className="lg:hidden" />
        <NavBarLogo />
      </div>
      {/* Below `lg` the inline row no longer fits next to the logo and the account controls.
          Text zoomed without the viewport (the breakpoint stays put) can still outgrow it; the row
          then wraps between links instead of pushing the account controls off the page. */}
      <nav className="hidden min-w-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 lg:flex">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={link.href === currentHref ? 'page' : undefined}
            className="link-underline whitespace-nowrap"
          >
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
    <div className="flex w-full items-center justify-between">
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
// `min-w-0`: the placeholders shrink with the row instead of widening a 320 px page.
const NavSkeleton = () => (
  <div className="flex min-w-0 items-center gap-4 animate-pulse" aria-hidden="true">
    <div className="h-5 w-16 rounded bg-(--line)" />
    <div className="h-5 w-20 rounded bg-(--line)" />
    <div className="h-5 w-24 rounded bg-(--line)" />
    <div className="h-5 w-20 rounded bg-(--line)" />
  </div>
)

export { NavContent }
