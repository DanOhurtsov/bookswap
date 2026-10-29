'use client'

import { Check, LoaderCircle, createLucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import type { InviteLinkController, InviteLinkState } from '../model/use-invite-link'
import { PROFILE_ACTION, PROFILE_ICON_ACTION } from './ProfileParts'

const LABELS = {
  idle: 'Запросити друзів',
  loading: 'Готуємо посилання…',
  done: 'Посилання скопійовано',
  error: 'Запросити друзів',
} as const

/**
 * A person with a link: the invitation is a link to copy, not a request to someone (Lucide has no
 * such icon). Lucide's `user-round` with its `link` as the corner badge, where `user-round-cog` keeps
 * its cog: the link is scaled to 0.48 into the 24 grid, so the stroke stays Lucide's 2.
 */
const UserRoundLink = createLucideIcon('user-round-link', [
  ['path', { d: 'M2 21a8 8 0 0 1 10.434-7.62', key: 'shoulders' }],
  ['circle', { cx: '10', cy: '8', r: '5', key: 'head' }],
  [
    'path',
    {
      d: 'M17.2 18.64a2.4 2.4 0 0 0 3.619.259l1.44-1.44a2.4 2.4 0 0 0-3.394-3.394l-.826.821',
      key: 'link-a',
    },
  ],
  [
    'path',
    {
      d: 'M19.12 17.68a2.4 2.4 0 0 0-3.619-.259l-1.44 1.44a2.4 2.4 0 0 0 3.394 3.394l.821-.821',
      key: 'link-b',
    },
  ],
])

function InviteIcon({ state, className }: { state: InviteLinkState; className: string }) {
  if (state.kind === 'loading') {
    return <LoaderCircle aria-hidden="true" className={`${className} animate-spin`} />
  }
  if (state.kind === 'done') return <Check aria-hidden="true" className={className} />

  return <UserRoundLink aria-hidden="true" className={className} />
}

/**
 * «Запросити друзів» (canvas «Profile — стани компонентів»): idle → «Готуємо посилання…» →
 * «Посилання скопійовано» for 2.2 s → idle. Two looks on one controller:
 *
 * - `icon` — the profile card's: the icon turns into the spinner and the tick in a box that never
 *   changes size, its name follows the state. Being blocked while busy, it stays focusable, so a
 *   keyboard user does not lose their place. The copy is told by a toast, a failure under the card
 *   (`InviteFailure`): both reach a touch screen, where there is no tooltip;
 * - `outline` — the empty friends list's text button, whose label says the state itself.
 */
export function InviteButton({
  controller,
  variant,
}: {
  controller: InviteLinkController
  variant: 'icon' | 'outline'
}) {
  const { state, invite } = controller
  const busy = state.kind === 'loading' || state.kind === 'done'
  const label = LABELS[state.kind]

  if (variant === 'icon') {
    return (
      <Tooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={PROFILE_ICON_ACTION}
          aria-label={label}
          aria-busy={state.kind === 'loading'}
          disabled={busy}
          focusableWhenDisabled
          onClick={invite}
        >
          <InviteIcon state={state} className="size-5" />
        </Button>
      </Tooltip>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={PROFILE_ACTION}
      onClick={invite}
      disabled={busy}
      aria-live="polite"
    >
      <InviteIcon state={state} className="size-[18px]" />
      {label}
    </Button>
  )
}

/** Why the invitation did not work, with the link itself when only copying failed. */
export function InviteFailure({ state }: { state: InviteLinkState }) {
  if (state.kind !== 'error') return null

  return (
    <p role="alert" className="m-0 text-sm leading-5 text-(--error)">
      {state.message}
      {state.link !== undefined && (
        <>
          {' '}
          <span className="break-all text-(--fg) select-all">{state.link}</span>
        </>
      )}
    </p>
  )
}
