'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { currentAddress, loginHref } from './return-to'
import type { SessionState } from './use-session'

/**
 * BS-146: the one guard rule of every signed-in page — a guest is sent to sign in, and comes back
 * here afterwards. Only `guest` redirects: `loading` is not an answer yet, and `error` is not
 * "signed out". The address is read when the redirect happens, in the browser, because the
 * fragment never reaches the server.
 */
export function useGuestRedirect(status: SessionState['status']): void {
  const router = useRouter()

  useEffect(() => {
    if (status === 'guest') router.replace(loginHref(currentAddress()))
  }, [status, router])
}

// The address changes on back/forward and on a fragment jump; any other render reads it afresh anyway.
function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener('hashchange', onChange)

  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener('hashchange', onChange)
  }
}

const browserLoginHref = (): string => loginHref(currentAddress())
// The server has no address bar; hydration starts from the same plain link.
const serverLoginHref = (): string => '/login'

type LoginLinkProps = {
  children: ReactNode
  className?: string
}

/** «Увійти» from a signed-in page: after signing in, the visitor is back on this page. */
export function LoginLink({ children, className }: LoginLinkProps) {
  const href = useSyncExternalStore(subscribe, browserLoginHref, serverLoginHref)

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}
