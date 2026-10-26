'use client'

import Link from 'next/link'
import type { SessionState } from '@/app/lib/use-session'
import { useSession } from '@/app/lib/use-session'
import { LoginLink, useGuestRedirect } from '@/app/lib/use-login-redirect'
import { assertNever } from '@/app/lib/assert-never'
import { FriendsPageContent } from '@/components/Friends/FriendsPageContent'
import { Shell } from '@/components/Shell'
import { SearchIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { USER_SEARCH_PATH } from '@/features/user-search/index.client'

function FriendsSessionBoundary() {
  const session = useSession()

  useGuestRedirect(session.state.status)

  return <SessionStateView state={session.state} onRetry={session.reload} />
}

function SessionStateView({ state, onRetry }: { state: SessionState; onRetry: () => void }) {
  switch (state.status) {
    case 'loading':
      return <SessionLoadingView />
    case 'error':
      return <SessionErrorView message={state.message} onRetry={onRetry} />
    case 'guest':
      return <GuestRedirectView />
    case 'authenticated':
      return (
        <Shell
          title="Друзі"
          description="Переглядайте бібліотеки друзів і керуйте запитами без зайвого шуму."
          cta={<FindPeopleLink />}
        >
          <FriendsPageContent />
        </Shell>
      )
    default:
      return assertNever(state)
  }
}

/**
 * The page's one action, the same in every state so the title row never shifts. The search page
 * guards its own session.
 */
function FindPeopleLink() {
  return (
    <Link href={USER_SEARCH_PATH} className={buttonVariants()}>
      <SearchIcon aria-hidden="true" />
      Знайти людей
    </Link>
  )
}

function SessionLoadingView() {
  return (
    <Shell title="Друзі" cta={<FindPeopleLink />}>
      <div className="space-y-3" aria-label="Перевіряю сесію">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    </Shell>
  )
}

function SessionErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell title="Друзі" cta={<FindPeopleLink />}>
      <div className="space-y-4">
        <div
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {message}
        </div>
        <Button type="button" variant="outline" onClick={onRetry}>
          Спробувати ще раз
        </Button>
      </div>
    </Shell>
  )
}

function GuestRedirectView() {
  return (
    <Shell title="Друзі">
      <p className="text-sm text-muted-foreground">
        Переадресовую до входу. <LoginLink>Увійти зараз</LoginLink>
      </p>
    </Shell>
  )
}

export { FriendsSessionBoundary }
