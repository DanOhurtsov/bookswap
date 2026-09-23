'use client'

import Link from 'next/link'
import { useCallback, useState, type FormEvent } from 'react'
import {
  friendshipStateResponseSchema,
  userSearchRequestSchema,
  userSearchResponseSchema,
  type FriendRequest,
  type PublicUser,
  type UserSearchResult,
} from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { assertNever } from '@/app/lib/assert-never'
import { useFriends } from '@/app/lib/use-friends'
import { validate, type FieldErrors } from '@/app/lib/validation'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FriendsList } from '@/components/Friends/FriendsList'
import { FriendsSearch, type SearchMode } from '@/components/Friends/FriendsSearch'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

interface SearchQuery {
  mode: SearchMode
  value: string
}

interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

function FriendsPageContent() {
  const { state, reload } = useFriends()
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [mode, setMode] = useState<SearchMode>('name')
  const [query, setQuery] = useState('')
  const [lastSearch, setLastSearch] = useState<SearchQuery>()
  const [results, setResults] = useState<UserSearchResult[]>()
  const [searching, setSearching] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})

  const search = useCallback(async ({ mode: searchMode, value }: SearchQuery): Promise<void> => {
    setSearching(true)

    try {
      const parameter = searchMode === 'name' ? 'q' : 'email'
      const response = await apiRequest(`/users?${parameter}=${encodeURIComponent(value)}`, {
        schema: userSearchResponseSchema,
      })

      setResults(response.results)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setSearching(false)
    }
  }, [])

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      reload()

      if (lastSearch !== undefined) await search(lastSearch)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
      setConfirmation(undefined)
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setFailure(undefined)

    const result = validate(
      userSearchRequestSchema,
      mode === 'name' ? { q: query } : { email: query },
    )

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})

    const value = mode === 'name' ? (result.data.q ?? '') : (result.data.email ?? '')
    const nextSearch: SearchQuery = { mode, value }

    setLastSearch(nextSearch)
    void search(nextSearch)
  }

  const sendRequest = (userId: string): void => {
    void run(`request:${userId}`, async () => {
      await apiRequest('/friends/requests', {
        method: 'POST',
        body: { userId },
        schema: friendshipStateResponseSchema,
      })
    })
  }

  const respond = (requestId: string, action: 'accept' | 'decline'): void => {
    void run(`${action}:${requestId}`, async () => {
      await apiRequest(`/friends/requests/${requestId}`, {
        method: 'PATCH',
        body: { action },
        schema: friendshipStateResponseSchema,
      })
    })
  }

  const removeLink = (userId: string): Promise<void> =>
    run(`remove:${userId}`, async () => {
      await apiRequest(`/friends/${userId}`, { method: 'DELETE' })
    })

  const block = (userId: string): Promise<void> =>
    run(`block:${userId}`, async () => {
      await apiRequest(`/friends/${userId}/block`, { method: 'POST' })
    })

  function confirmRemoveFriend(friend: PublicUser): void {
    setConfirmation({
      title: `Видалити ${friend.displayName} з друзів?`,
      description:
        'Активні позичання це не скасує. Ви більше не бачитимете бібліотеку одне одного.',
      confirmLabel: 'Видалити',
      run: () => removeLink(friend.id),
    })
  }

  function confirmBlock(user: PublicUser): void {
    setConfirmation({
      title: `Заблокувати ${user.displayName}?`,
      description:
        'Ця людина не зможе надсилати вам запити й бачити вашу бібліотеку. Дружбу буде розірвано.',
      confirmLabel: 'Заблокувати',
      run: () => block(user.id),
    })
  }

  function confirmCancelRequest(request: FriendRequest): void {
    setConfirmation({
      title: `Скасувати запит до ${request.user.displayName}?`,
      description: 'Людина більше не побачить його серед вхідних запитів.',
      confirmLabel: 'Скасувати запит',
      run: () => removeLink(request.user.id),
    })
  }

  switch (state.status) {
    case 'loading':
      return <FriendsPageSkeleton />
    case 'error':
      return <FriendsLoadError message={state.message} onRetry={reload} />
    case 'ready':
      break
    default:
      return assertNever(state)
  }

  return (
    <div className="space-y-8">
      <ErrorAlert error={failure} />

      <FriendsList
        friends={state.friends}
        incoming={state.incoming}
        outgoing={state.outgoing}
        busyKey={busyKey}
        onRespond={respond}
        onCancelRequest={confirmCancelRequest}
        onRemoveFriend={confirmRemoveFriend}
        onBlockFriend={confirmBlock}
      />

      <div className="border-t pt-7">
        <FriendsSearch
          mode={mode}
          query={query}
          results={results}
          searching={searching}
          errors={errors}
          busyKey={busyKey}
          incoming={state.incoming}
          onModeChange={(nextMode) => {
            setMode(nextMode)
            setResults(undefined)
            setErrors({})
          }}
          onQueryChange={setQuery}
          onSubmit={submitSearch}
          onRequest={sendRequest}
          onAccept={(requestId) => respond(requestId, 'accept')}
          onUnblock={(userId) => void removeLink(userId)}
        />
      </div>

      <nav className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-5 text-sm text-muted-foreground">
        <Link href="/profile" className="hover:text-foreground">
          Профіль
        </Link>
        <Link href="/library" className="hover:text-foreground">
          Моя бібліотека
        </Link>
        <Link href="/catalog" className="hover:text-foreground">
          Каталог
        </Link>
      </nav>

      <ConfirmDialog
        open={confirmation !== undefined}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
        confirmLabel={confirmation?.confirmLabel ?? 'Підтвердити'}
        pending={busyKey !== undefined}
        onConfirm={() => void confirmation?.run()}
        onCancel={() => setConfirmation(undefined)}
      />
    </div>
  )
}

function ErrorAlert({ error }: { error: unknown }) {
  if (error === undefined || error === null) return null

  const constraints = error instanceof ApiRequestError ? error.constraints : []
  // §0.3 no-base-to-string: `String(unknown)` на об'єкті давало «[object Object]».
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Невідома помилка'

  return (
    <div
      className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      <p>{message}</p>
      {constraints.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {constraints.map((constraint) => (
            <li key={constraint}>{constraint}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FriendsLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-4">
      <ErrorAlert error={new Error(message)} />
      <Button type="button" variant="outline" onClick={onRetry}>
        Спробувати ще раз
      </Button>
    </div>
  )
}

function FriendsPageSkeleton() {
  return (
    <div className="space-y-6" aria-label="Завантажую друзів">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <div className="overflow-hidden rounded-xl border">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 border-b p-4 last:border-b-0">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export { FriendsPageContent }
