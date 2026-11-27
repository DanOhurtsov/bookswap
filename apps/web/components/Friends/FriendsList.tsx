'use client'

import { useState } from 'react'
import type { Friend, PublicUser } from '@bookswap/shared'
import { SearchIcon, XIcon } from 'lucide-react'
import { FriendRow } from '@/components/Friends/FriendRow'
import {
  FRIENDS_SORT_LABELS,
  friendsResultLabel,
  hasFriendsSearch,
  visibleFriends,
  type FriendsSort,
} from '@/components/Friends/friends-view'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type SortOption = { value: FriendsSort; label: string }

const SORT_OPTIONS: readonly SortOption[] = (['recent', 'name'] as const).map((value) => ({
  value,
  label: FRIENDS_SORT_LABELS[value],
}))

interface FriendsListProps {
  friends: Friend[]
  busyKey: string | undefined
  onRemoveFriend: (friend: PublicUser, returnFocusTo: HTMLElement | null) => void
  onBlockFriend: (friend: PublicUser, returnFocusTo: HTMLElement | null) => void
  /** Opens «Знайти друзів»: where an empty list and a search with no match point. */
  onFindFriends: () => void
}

/**
 * «Мої друзі»: the search among friends, the order, and one card per friend. The search and the
 * order only rearrange the list already loaded — no request — and stay on this tab (BS-154 report:
 * moving them into the address needs the loans search-draft mechanism, outside this screen).
 */
function FriendsList({
  friends,
  busyKey,
  onRemoveFriend,
  onBlockFriend,
  onFindFriends,
}: FriendsListProps) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<FriendsSort>('recent')

  if (friends.length === 0) {
    return (
      <div className="friends-empty">
        <h2 className="friends-empty__title">Тут поки нікого</h2>
        <p className="friends-empty__text">
          Знайдіть людину й надішліть запит у друзі або запросіть друзів за посиланням.
        </p>
        <div className="friends-empty__actions">
          <button
            type="button"
            className="friends-button friends-button--primary"
            onClick={onFindFriends}
          >
            Знайти нових друзів
          </button>
        </div>
      </div>
    )
  }

  const shown = visibleFriends(friends, query, sort)

  return (
    <>
      <div className="friends-toolbar">
        <div className="friends-search">
          <SearchIcon className="friends-search__icon" aria-hidden="true" />
          <label htmlFor="friends-query" className="sr-only">
            Пошук серед друзів
          </label>
          <input
            id="friends-query"
            className="friends-search__input"
            type="search"
            autoComplete="off"
            placeholder="Ім’я або нік"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="friends-search__clear"
              aria-label="Очистити пошук"
              onClick={() => {
                setQuery('')
              }}
            >
              <XIcon aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="friends-toolbar__sort">
          <label htmlFor="friends-sort" className="sr-only">
            Сортування
          </label>
          <Select
            value={SORT_OPTIONS.find((option) => option.value === sort) ?? null}
            isItemEqualToValue={(one: SortOption, other: SortOption) => one.value === other.value}
            onValueChange={(option: SortOption | null) => {
              if (option !== null) setSort(option.value)
            }}
          >
            <SelectTrigger id="friends-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="friends-result" aria-live="polite">
        {friendsResultLabel(shown.length, friends.length, query)}
      </p>

      {shown.length === 0 && hasFriendsSearch(query) ? (
        <div className="friends-empty">
          <h2 className="friends-empty__title">Нікого не знайдено</h2>
          <p className="friends-empty__text">
            Серед друзів немає «{query.trim()}». Можливо, ви ще не додали цю людину.
          </p>
          <div className="friends-empty__actions">
            <button
              type="button"
              className="friends-button friends-button--secondary"
              onClick={() => {
                setQuery('')
              }}
            >
              Скинути пошук
            </button>
            <button
              type="button"
              className="friends-button friends-button--primary"
              onClick={onFindFriends}
            >
              Знайти нових друзів
            </button>
          </div>
        </div>
      ) : (
        <ul className="friend-cards" aria-label="Мої друзі">
          {shown.map((friend) => (
            <FriendRow
              key={friend.user.id}
              friend={friend}
              busy={busyKey !== undefined}
              onRemove={(menuTrigger) => {
                onRemoveFriend(friend.user, menuTrigger)
              }}
              onBlock={(menuTrigger) => {
                onBlockFriend(friend.user, menuTrigger)
              }}
            />
          ))}
        </ul>
      )}
    </>
  )
}

export { FriendsList }
