'use client'

import Link from 'next/link'
import type { ProfileFriend } from '../model/profile-view'
import type { InviteLinkController } from '../model/use-invite-link'
import { InviteButton } from './InviteButton'
import { EmptySection, ProfileAvatar, ProfileCard, SeeAllLink } from './ProfileParts'

/** «Друзі»: up to six faces, a rail on a phone and three in a row from a tablet up. */
export function FriendsCard({
  friends,
  invite,
}: {
  friends: { items: ProfileFriend[]; total: number }
  invite: InviteLinkController
}) {
  return (
    <ProfileCard aria-labelledby="profile-friends" className="flex flex-col gap-2 px-6 pt-5 pb-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="profile-friends" className="m-0 text-lg leading-[26px] font-semibold">
          Друзі
        </h2>
        {friends.total > 0 && <SeeAllLink href="/friends">Усі {friends.total}</SeeAllLink>}
      </div>

      {friends.items.length === 0 ? (
        <EmptySection
          title="Ще немає друзів"
          text="Запросіть друзів — і побачите їхні бібліотеки."
          action={<InviteButton controller={invite} variant="outline" />}
        />
      ) : (
        <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 md:grid md:grid-cols-3 md:overflow-visible">
          {friends.items.map((friend) => (
            <li key={friend.key} className="w-24 shrink-0 md:w-auto">
              <Link
                href={friend.href}
                className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center text-[13px] font-semibold text-inherit no-underline hover:bg-(--bg)"
              >
                <ProfileAvatar
                  user={friend.user}
                  className="size-12"
                  fallbackClassName="text-[17px]"
                />
                <span className="w-full truncate">{friend.user.displayName}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ProfileCard>
  )
}
