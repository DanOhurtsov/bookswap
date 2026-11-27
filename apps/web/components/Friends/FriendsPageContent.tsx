'use client'

import type { ReactNode } from 'react'
import { ApiRequestError } from '@/app/lib/api'
import { assertNever } from '@/app/lib/assert-never'
import { useFriends, type FriendsState } from '@/app/lib/use-friends'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FindFriendsPanel } from '@/components/Friends/FindFriendsPanel'
import { FriendRequestsPanel } from '@/components/Friends/FriendRequestsPanel'
import { FriendsList } from '@/components/Friends/FriendsList'
import {
  FRIENDS_TABS,
  incomingRows,
  pendingIncomingCount,
  type FriendsTab,
} from '@/components/Friends/friends-view'
import { useFriendActions, type FriendActions } from '@/components/Friends/use-friend-actions'
import { useFriendsTab } from '@/components/Friends/use-friends-tab'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TAB_LABELS: Readonly<Record<FriendsTab, string>> = {
  friends: 'Мої друзі',
  requests: 'Запити',
  find: 'Знайти друзів',
}

/**
 * BS-154, canvas «Friends Page»: three tabs over one read of the friends and the requests. The tab
 * row is drawn in every state, so the page does not jump when the lists arrive; «Знайти друзів»
 * needs neither list and opens at once.
 */
function FriendsPageContent() {
  const friends = useFriends()
  const { state, reload } = friends
  const actions = useFriendActions(friends)
  const { tab, selectTab } = useFriendsTab()
  const counts = tabCounts(state, actions)

  return (
    <>
      <ErrorAlert error={actions.failure} />

      <Tabs
        className="friends-tabs"
        value={tab}
        onValueChange={(next) => {
          const selected = FRIENDS_TABS.find((value) => value === next)
          if (selected !== undefined) selectTab(selected)
        }}
      >
        <TabsList variant="line" aria-label="Розділи друзів" className="friends-tabs__list">
          {FRIENDS_TABS.map((value) => (
            <TabsTrigger key={value} value={value} className="friends-tabs__tab">
              {TAB_LABELS[value]}
              <TabCount tab={value} counts={counts} />
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="friends" className="friends-tabs__panel">
          <ListsBody state={state} onRetry={reload}>
            {(ready) => (
              <FriendsList
                friends={ready.friends}
                busyKey={actions.busyKey}
                onRemoveFriend={actions.confirmRemoveFriend}
                onBlockFriend={actions.confirmBlock}
                onFindFriends={() => {
                  selectTab('find')
                }}
              />
            )}
          </ListsBody>
        </TabsContent>

        <TabsContent value="requests" className="friends-tabs__panel">
          <ListsBody state={state} onRetry={reload}>
            {(ready) => (
              <FriendRequestsPanel
                incoming={incomingRows(ready, actions.answered)}
                outgoing={ready.outgoing}
                busyKey={actions.busyKey}
                onRespond={actions.respond}
                onCancelRequest={actions.confirmCancelRequest}
              />
            )}
          </ListsBody>
        </TabsContent>

        <TabsContent value="find" className="friends-tabs__panel">
          <FindFriendsPanel />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={actions.confirmation !== undefined}
        title={actions.confirmation?.title ?? ''}
        description={actions.confirmation?.description}
        confirmLabel={actions.confirmation?.confirmLabel ?? 'Підтвердити'}
        pending={actions.busyKey !== undefined}
        onConfirm={() => void actions.confirmation?.run()}
        onCancel={actions.dismissConfirmation}
      />
    </>
  )
}

type TabCounts = { friends: number; requests: number } | undefined

function tabCounts(state: FriendsState, actions: FriendActions): TabCounts {
  if (state.status !== 'ready') return undefined

  return {
    friends: state.friends.length,
    requests: pendingIncomingCount(state, actions.answered),
  }
}

/**
 * The canvas counts: every friend; the incoming requests still waiting, warm while there are any.
 * None while the lists load, none for «Знайти друзів», none for no waiting requests.
 */
function TabCount({ tab, counts }: { tab: FriendsTab; counts: TabCounts }) {
  if (counts === undefined || tab === 'find') return null

  const count = counts[tab]

  if (tab === 'requests') {
    if (count === 0) return null

    return <span className="friends-tabs__count friends-tabs__count--hot">{count}</span>
  }

  return <span className="friends-tabs__count">{count}</span>
}

type ReadyFriends = Extract<FriendsState, { status: 'ready' }>

type ListsBodyProps = {
  state: FriendsState
  onRetry: () => void
  children: (ready: ReadyFriends) => ReactNode
}

/** The loading and error states both list tabs share; the tab itself renders the ready lists. */
function ListsBody({ state, onRetry, children }: ListsBodyProps) {
  switch (state.status) {
    case 'loading':
      return <FriendsPageSkeleton />
    case 'error':
      return (
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
      )
    case 'ready':
      return children(state)
    default:
      return assertNever(state)
  }
}

function ErrorAlert({ error }: { error: unknown }) {
  if (error === undefined || error === null) return null

  const constraints = error instanceof ApiRequestError ? error.constraints : []
  // §0.3 no-base-to-string: `String(unknown)` on an object gave «[object Object]».
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Невідома помилка'

  return (
    <div className="alert alert--error friends-alert" role="alert">
      <p>{message}</p>
      {constraints.length > 0 && (
        <ul>
          {constraints.map((constraint) => (
            <li key={constraint}>{constraint}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FriendsPageSkeleton() {
  return (
    <div className="friend-cards" aria-label="Завантажую друзів">
      {[0, 1, 2].map((item) => (
        <div key={item} className="friend-card friend-card--placeholder">
          <Skeleton className="size-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}

export { FriendsPageContent }
