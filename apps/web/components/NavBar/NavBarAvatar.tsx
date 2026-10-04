'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { Me } from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ThemeToggleMenuItem } from '@/components/ThemeToggle'
import { NAVBAR_PROFILE_LINKS } from '@/constants/navigation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)

  if (parts.length === 0) return '?'

  const first = Array.from(parts[0] ?? '')
  const last = Array.from(parts.at(-1) ?? '')
  const initials =
    parts.length === 1 ? first.slice(0, 2).join('') : `${first[0] ?? ''}${last[0] ?? ''}`

  return initials.toLocaleUpperCase('uk-UA')
}

export const NavBarAvatar = ({ user }: { user: Me }) => {
  const router = useRouter()
  const { setGuest } = useSession()
  const [logoutError, setLogoutError] = useState<string>()
  const [loggingOut, setLoggingOut] = useState(false)

  async function logout(): Promise<void> {
    setLogoutError(undefined)
    setLoggingOut(true)

    try {
      await apiRequest('/auth/logout', { method: 'POST' })
    } catch (error) {
      // A failed logout must not be mistaken for a confirmed one — the user
      // is still signed in, so the menu stays open and says so instead of
      // redirecting to `/login` while the cookie is still valid.
      setLogoutError(error instanceof ApiRequestError ? error.message : describeError(error))
      setLoggingOut(false)
      return
    }

    // Sets `guest` through the shared session context, so every mounted
    // consumer drops the old identity without waiting on a fresh GET.
    setGuest()
    router.replace('/login')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="unstyled" aria-label={`Відкрити меню профілю: ${user.displayName}`}>
            <Avatar size="lg">
              {user.avatarUrl !== null && (
                <AvatarImage src={user.avatarUrl} alt={user.displayName} />
              )}
              <AvatarFallback>{getInitials(user.displayName)}</AvatarFallback>
            </Avatar>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          {NAVBAR_PROFILE_LINKS.map((link) => (
            <DropdownMenuItem key={link.href} render={<Link href={link.href} />}>
              {link.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ThemeToggleMenuItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          closeOnClick={false}
          disabled={loggingOut}
          onClick={() => void logout()}
        >
          Вийти
        </DropdownMenuItem>
        {logoutError !== undefined && (
          <p role="alert" className="px-1.5 py-1 text-xs text-destructive">
            {logoutError}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
