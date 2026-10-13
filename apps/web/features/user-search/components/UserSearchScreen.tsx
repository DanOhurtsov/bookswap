'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, type ReactNode } from 'react'
import type { UserSearchResult } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { Shell } from '@/components/Shell'
import { Button, buttonVariants } from '@/components/ui/button'
import { useFoundUserActions, type FoundUserActions } from '../model/use-found-user-actions'
import { useUserSearchAddress } from '../model/use-user-search-address'
import type { UserSearchView } from '../model/user-search'
import { FoundUserList } from './FoundUserList'
import { UserSearchForm } from './UserSearchForm'

const NO_RESULTS: readonly UserSearchResult[] = []
const NOTE_CLASS =
  'rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'

/** `/friends/search`: the whole answer of the people search, for signed-in people only. */
export function UserSearchScreen() {
  const router = useRouter()
  const { state: session, reload } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  switch (session.status) {
    case 'loading':
      return (
        <ScreenShell>
          <p className={NOTE_CLASS}>Перевіряю сесію…</p>
        </ScreenShell>
      )
    case 'guest':
      return (
        <ScreenShell>
          <p className={NOTE_CLASS}>Потрібен вхід. Переадресовую…</p>
        </ScreenShell>
      )
    case 'error':
      // Not a sign-out: the session could not be checked (5xx, network). Nowhere to redirect —
      // say what failed and let the person ask again.
      return (
        <ScreenShell>
          <div className="space-y-4">
            <div
              className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              {session.message}
            </div>
            <Button type="button" variant="outline" onClick={reload}>
              Спробувати ще раз
            </Button>
          </div>
        </ScreenShell>
      )
    case 'authenticated':
      // Keyed by the person: another account never starts from the previous one's search.
      return <UserSearchPage key={session.user.id} viewerId={session.user.id} />
  }
}

function ScreenShell({ children }: { children: ReactNode }) {
  return (
    <Shell
      title="Пошук людей"
      description="Знаходьте людей серед усіх користувачів BookSwap і додавайте їх у друзі."
      cta={
        <Link href="/friends" className={buttonVariants({ variant: 'outline' })}>
          До друзів
        </Link>
      }
    >
      {children}
    </Shell>
  )
}

function UserSearchPage({ viewerId }: { viewerId: string }) {
  const search = useUserSearchAddress(viewerId)
  const actions = useFoundUserActions(
    viewerId,
    search.view.status === 'ready' ? search.view.results : NO_RESULTS,
    search.active,
  )
  const errorId = useId()
  const error = search.errors.form

  return (
    <ScreenShell>
      <div className="space-y-4">
        <UserSearchForm
          text={search.text}
          loading={search.view.status === 'loading'}
          errorId={error === undefined ? undefined : errorId}
          onTextChange={(text) => {
            actions.dismissFailure()
            search.changeText(text)
          }}
          onSubmit={search.submit}
        />
        {error !== undefined && (
          <p id={errorId} className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {actions.failure !== undefined && (
          <p
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {describeError(actions.failure)}
          </p>
        )}
        <ScreenBody
          view={search.view}
          hasError={error !== undefined}
          actions={actions}
          onRetry={search.submit}
        />
      </div>
    </ScreenShell>
  )
}

type ScreenBodyProps = {
  view: UserSearchView
  hasError: boolean
  actions: FoundUserActions
  onRetry: () => void
}

function ScreenBody({ view, hasError, actions, onRetry }: ScreenBodyProps) {
  switch (view.status) {
    case 'idle':
      // The validation message already says what is wrong with the text.
      return hasError ? null : (
        <p className={NOTE_CLASS}>Введіть щонайменше два символи імені або повну email-адресу.</p>
      )
    case 'waiting':
    case 'loading':
      return (
        <p className={NOTE_CLASS} role="status">
          Шукаю людей…
        </p>
      )
    case 'failed':
      return (
        <div
          className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
          role="alert"
        >
          <p className="text-destructive">{describeError(view.error)}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Спробувати ще раз
          </Button>
        </div>
      )
    case 'ready':
      return view.results.length === 0 ? (
        <p className={NOTE_CLASS} role="status">
          Нікого не знайдено. Спробуйте інше ім’я або перевірте email.
        </p>
      ) : (
        <section aria-label="Результати пошуку людей" className="space-y-2">
          <p className="text-sm text-muted-foreground" role="status">
            Знайдено людей: {view.results.length}
          </p>
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <FoundUserList results={view.results} actions={actions} />
          </div>
        </section>
      )
  }
}
