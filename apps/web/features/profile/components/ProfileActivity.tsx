import Link from 'next/link'
import { ArrowUpRight, Check, CornerDownLeft, HandHelping, Plus, X } from 'lucide-react'
import { LOANS_HISTORY_HREF } from '@/features/loans'
import { cn } from '@/lib/utils'
import type { ActivityLine, ActivityTone } from '../model/profile-view'
import { EmptySection, PROFILE_CARD, SeeAllLink } from './ProfileParts'

const ICONS = {
  request: HandHelping,
  approved: Check,
  rejected: X,
  handed: ArrowUpRight,
  returned: CornerDownLeft,
  added: Plus,
} as const

/**
 * The canvas board «ActivityRow» colours, made of the theme's tokens so they hold in the dark theme
 * too. The text carries the meaning on its own.
 */
const TONE: Record<ActivityTone, string> = {
  action: 'bg-[color-mix(in_oklch,var(--warn),transparent_86%)] text-(--warn)',
  positive: 'bg-[color-mix(in_oklch,var(--ok),transparent_86%)] text-(--ok)',
  out: 'bg-[color-mix(in_oklch,#4a7bb0,transparent_86%)] text-[#4a7bb0]',
  neutral: 'bg-[color-mix(in_oklch,var(--bookswap-muted),transparent_88%)] text-(--bookswap-muted)',
}

/** «Остання активність»: the latest five steps, each a link to where it happened. */
export function ProfileActivity({ lines }: { lines: ActivityLine[] }) {
  return (
    <section aria-labelledby="profile-activity" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2
          id="profile-activity"
          className="m-0 text-xl leading-7 font-semibold md:text-[22px] md:leading-[30px]"
        >
          Остання активність
        </h2>
        <SeeAllLink href={LOANS_HISTORY_HREF}>Історія позик</SeeAllLink>
      </div>

      {lines.length === 0 ? (
        <EmptySection
          title="Активності поки немає"
          text="Тут з’являться позики, повернення та нові книжки."
          action={
            <Link className="link-underline" href="/catalog">
              Перейти до каталогу
            </Link>
          }
        />
      ) : (
        <div className={cn(PROFILE_CARD, 'overflow-hidden')}>
          <ul className="m-0 list-none p-0">
            {lines.map((line) => {
              const Icon = ICONS[line.icon]

              return (
                <li key={line.key} className="border-t border-(--line) first:border-t-0">
                  <Link
                    href={line.href}
                    className="flex min-h-16 items-center gap-3.5 px-[18px] py-2.5 text-inherit no-underline hover:bg-(--bg)"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'inline-flex size-9 shrink-0 items-center justify-center rounded-full',
                        TONE[line.tone],
                      )}
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1 text-[15px] leading-[22px]">{line.text}</span>
                    <span className="shrink-0 text-[13px] leading-[18px] text-(--bookswap-muted)">
                      {line.when}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
