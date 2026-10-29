'use client'

import { useEffect, useRef, useState } from 'react'
import { describeError } from '@/app/lib/api'
import { useToastManager } from '@/components/ui/toast'
import { createInviteLink } from '@/features/network/index.client'

/** How long «Посилання скопійовано» stays before the button returns to «Запросити друзів». */
export const INVITE_DONE_MS = 2200

export type InviteLinkState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done' }
  /** `link` is set when the invitation exists and only copying failed: it can be copied by hand. */
  | { kind: 'error'; message: string; link?: string }

export interface InviteLinkController {
  state: InviteLinkState
  invite: () => void
}

/**
 * BS-148: «Запросити друзів» — a new link invitation, copied to the clipboard. The profile has two
 * buttons for it (the card and the empty friends list); one controller drives both. The copy is also
 * told by a toast: the card's button is an icon, and a touch screen shows no tooltip for it.
 */
export function useInviteLink(): InviteLinkController {
  const [state, setState] = useState<InviteLinkState>({ kind: 'idle' })
  const toasts = useToastManager()
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  async function run(): Promise<void> {
    clearTimeout(resetTimer.current)
    setState({ kind: 'loading' })

    let link: string

    try {
      link = await createInviteLink(window.location.origin)
    } catch (error) {
      setState({
        kind: 'error',
        message: `Не вдалося створити посилання. ${describeError(error)}`.trim(),
      })

      return
    }

    try {
      await navigator.clipboard.writeText(link)
    } catch {
      setState({
        kind: 'error',
        message: 'Посилання створено, але скопіювати його не вдалося:',
        link,
      })

      return
    }

    setState({ kind: 'done' })
    toasts.add({ title: 'Посилання скопійовано', timeout: INVITE_DONE_MS })
    resetTimer.current = setTimeout(() => {
      setState({ kind: 'idle' })
    }, INVITE_DONE_MS)
  }

  return {
    state,
    invite: () => {
      if (state.kind === 'loading' || state.kind === 'done') return
      void run()
    },
  }
}
