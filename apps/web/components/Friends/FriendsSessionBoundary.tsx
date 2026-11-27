'use client'

import { Suspense, type ReactNode } from 'react'
import type { SessionState } from '@/app/lib/use-session'
import { useSession } from '@/app/lib/use-session'
import { LoginLink, useGuestRedirect } from '@/app/lib/use-login-redirect'
import { assertNever } from '@/app/lib/assert-never'
import { FriendsPageContent } from '@/components/Friends/FriendsPageContent'
import { Skeleton } from '@/components/ui/skeleton'

function FriendsSessionBoundary() {
  const session = useSession()

  useGuestRedirect(session.state.status)

  return <SessionStateView state={session.state} onRetry={session.reload} />
}

function SessionStateView({ state, onRetry }: { state: SessionState; onRetry: () => void }) {
  switch (state.status) {
    case 'loading':
      return (
        <FriendsPage>
          <div className="space-y-3" aria-label="Перевіряю сесію">
            <Skeleton className="h-11 w-full max-w-md" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        </FriendsPage>
      )
    case 'error':
      return (
        <FriendsPage>
          <div className="friends-load-error" role="alert">
            <p>{state.message}</p>
            <button
              type="button"
              className="friends-button friends-button--secondary"
              onClick={onRetry}
            >
              Спробувати ще раз
            </button>
          </div>
        </FriendsPage>
      )
    case 'guest':
      return (
        <FriendsPage>
          <p className="friends-note friends-note--plain">
            Переадресовую до входу. <LoginLink>Увійти зараз</LoginLink>
          </p>
        </FriendsPage>
      )
    case 'authenticated':
      return (
        <FriendsPage>
          {/* `useSearchParams` (the open tab) needs a boundary of its own to prerender the page. */}
          <Suspense fallback={<Skeleton className="h-11 w-full max-w-md" />}>
            <FriendsPageContent />
          </Suspense>
        </FriendsPage>
      )
    default:
      return assertNever(state)
  }
}

/**
 * BS-154: the canvas «Friends Page» frame — the title and the line under it — in every state, the
 * waiting ones too. `.canvas-theme` gives the page the canvas palette from the first paint (globals.css).
 * The canvas has no action beside the title: finding people is the «Знайти друзів» tab.
 */
function FriendsPage({ children }: { children: ReactNode }) {
  return (
    <main className="page canvas-theme friends-page">
      <header className="friends-page__header">
        <h1 className="friends-page__title">Друзі</h1>
        <p className="friends-page__lead">Бачите бібліотеки одне одного і можете позичати книжки</p>
      </header>
      {children}
    </main>
  )
}

export { FriendsSessionBoundary }
