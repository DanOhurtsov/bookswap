'use client'

import Link from 'next/link'
import type { Me } from '@bookswap/shared'
import { Pencil } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { profileMetaLine, type ProfileStat } from '../model/profile-view'
import type { InviteLinkController } from '../model/use-invite-link'
import { InviteButton, InviteFailure } from './InviteButton'
import { PROFILE_CARD, PROFILE_ICON_ACTION, ProfileAvatar } from './ProfileParts'

/** Where «Редагувати профіль» leads (PO decision, 27.10.2026). */
export const PROFILE_EDIT_HREF = '/profile/edit'

/*
 * On a phone the card and the numbers are two cards (canvas, mobile); from a tablet up they are one.
 * The look of `PROFILE_CARD` is therefore switched per breakpoint, written out in full: Tailwind finds
 * only whole class names.
 */
const ONE_CARD_FROM_TABLET =
  'md:rounded-xl md:border md:border-(--line) md:bg-(--field-bg) md:p-6 md:shadow-(--canvas-card-shadow) lg:p-8'
const OWN_CARD_ON_PHONE = 'md:rounded-none md:border-0 md:bg-transparent md:shadow-none'

/**
 * The profile card: who I am, the two actions as icons in its top right corner, and the four numbers.
 * Renders from the session at once; the numbers come with the summary (`undefined` while they load).
 *
 * Canvas sizes: a phone centres the card, 84 px photo; a tablet lays it out in a row, 80 px; a desktop
 * the same with 96 px and more room. The text keeps clear of the icons: below them on a phone, beside
 * them from a tablet up.
 */
export function ProfileHero({
  user,
  stats,
  invite,
}: {
  user: Me
  stats: ProfileStat[] | undefined
  invite: InviteLinkController
}) {
  return (
    <section
      aria-label="Профіль"
      className={cn('flex flex-col gap-4 md:gap-0', ONE_CARD_FROM_TABLET)}
    >
      <div className={cn(PROFILE_CARD, OWN_CARD_ON_PHONE, 'relative px-5 pt-6 pb-5 md:p-0')}>
        <div className="absolute top-2 right-2 flex gap-1 md:top-0 md:right-0">
          <Tooltip label="Редагувати профіль">
            <Link
              href={PROFILE_EDIT_HREF}
              aria-label="Редагувати профіль"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon' }),
                PROFILE_ICON_ACTION,
              )}
            >
              <Pencil aria-hidden="true" />
            </Link>
          </Tooltip>
          <InviteButton controller={invite} variant="icon" />
        </div>

        <div className="flex flex-col items-center gap-3 text-center md:flex-row md:items-start md:gap-5 md:pr-24 md:text-left lg:items-center lg:gap-7">
          <ProfileAvatar
            user={user}
            className="size-[84px] shrink-0 md:size-20 lg:size-24"
            fallbackClassName="text-[30px] font-bold md:text-[28px] lg:text-[34px]"
          />
          <div className="flex w-full min-w-0 flex-1 flex-col gap-1">
            <h1 className="m-0 text-2xl leading-8 font-bold tracking-[-0.01em] [overflow-wrap:anywhere] md:text-[26px] md:leading-[34px] md:tracking-[-0.02em] lg:text-[30px] lg:leading-[38px]">
              {user.displayName}
            </h1>
            <span className="text-sm leading-5 text-(--bookswap-muted) [overflow-wrap:anywhere] md:text-[15px] md:leading-[22px]">
              {profileMetaLine(user)}
            </span>
            {/* No bio — nothing in its place (PO decision, 28.10.2026): a placeholder was only noise. */}
            {user.bio !== null && (
              <p className="mx-auto mt-1.5 mb-0 max-w-[560px] text-[15px] leading-[22px] whitespace-pre-line [overflow-wrap:anywhere] md:mx-0">
                {user.bio}
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 text-center empty:hidden md:mt-4 md:text-left">
          <InviteFailure state={invite.state} />
        </div>
      </div>

      <ProfileStats stats={stats} layout="split" />
    </section>
  )
}

// `items-start`: a stretched cell with `flex-col-reverse` packs its content at the bottom, so a label
// that wraps to two lines would push its neighbours' numbers lower than its own.
const STATS_LAYOUT = {
  /** Inside a card: under a line, two per row on a phone (the edit form). */
  inline: {
    grid: 'mt-7 grid grid-cols-2 items-start gap-4 border-t border-(--line) pt-5 md:grid-cols-4',
    item: 'flex flex-col-reverse gap-0.5 py-1',
    value: 'text-2xl leading-8',
    label: 'text-sm leading-5',
  },
  /** The profile card's: a compact card of its own on a phone, four in a row, centred. */
  split: {
    grid: cn(
      PROFILE_CARD,
      OWN_CARD_ON_PHONE,
      'grid grid-cols-4 items-start gap-1 px-1 py-3.5 md:mt-7 md:gap-4 md:border-t md:border-(--line) md:px-0 md:pt-5 md:pb-0',
    ),
    item: 'flex min-w-0 flex-col-reverse items-center gap-0.5 px-1 text-center md:items-start md:px-0 md:py-1 md:text-left',
    value: 'text-xl leading-7 md:text-2xl md:leading-8',
    label: 'text-xs leading-4 md:text-sm md:leading-5',
  },
} as const

/** The four numbers of the profile, in both modes; `undefined` while they load. */
export function ProfileStats({
  stats,
  layout = 'inline',
}: {
  stats: ProfileStat[] | undefined
  layout?: keyof typeof STATS_LAYOUT
}) {
  const look = STATS_LAYOUT[layout]

  if (stats === undefined) {
    return (
      <div aria-hidden="true" className={look.grid}>
        {[0, 1, 2, 3].map((slot) => (
          <Skeleton key={slot} className="h-12 md:h-14" />
        ))}
      </div>
    )
  }

  return (
    <dl className={cn(look.grid, 'mb-0')}>
      {stats.map((stat) => (
        // The number reads first, as in the mock-up; the label stays the term it describes.
        <div key={stat.key} className={look.item}>
          <dt className={cn(look.label, 'text-(--bookswap-muted) [overflow-wrap:anywhere]')}>
            {stat.label}
          </dt>
          <dd
            className={cn(
              look.value,
              'm-0 font-bold tracking-[-0.01em] tabular-nums [overflow-wrap:anywhere]',
            )}
          >
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
