'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { PublicUser, ResolveInvitationResponse } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import { acceptInvitation, resolveInvitation } from '../api/network-requests'
import {
  clearStashedInviteToken,
  readStashedInviteToken,
  stashInviteToken,
  tokenFromHash,
} from '../model/invite-token'

type Phase =
  | { kind: 'init' }
  | { kind: 'resolved'; resolved: ResolveInvitationResponse }
  | { kind: 'accepting'; resolved: ResolveInvitationResponse }
  | { kind: 'accepted'; inviter: PublicUser }
  | { kind: 'declined' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string }

const TERMINAL_MESSAGES = {
  EXPIRED: 'Строк дії цього запрошення минув. Попросіть запрошувача надіслати нове.',
  REVOKED: 'Запрошувач відкликав це запрошення.',
  EXHAUSTED: 'Це запрошення вже використано максимальну кількість разів.',
  SELF: 'Це ваше власне запрошення — поділіться ним з друзями.',
  ALREADY_ACCEPTED: 'Ви вже прийняли це запрошення.',
} as const

/**
 * `/invite#<token>`: shows who invited you and waits for an explicit «Прийняти».
 * A friendship is never created without that click. The raw token is only ever
 * held in memory (and, for a guest, in sessionStorage until login).
 */
export function InviteAcceptance() {
  const router = useRouter()
  const { state: session } = useSession()
  // Read once on the client: fragment first, then what a guest stashed before login.
  const [token] = useState<string | undefined>(() =>
    typeof window === 'undefined'
      ? undefined
      : (tokenFromHash(window.location.hash) ?? readStashedInviteToken()),
  )
  const [phase, setPhase] = useState<Phase>({ kind: 'init' })
  const authenticated = session.status === 'authenticated'
  const guest = session.status === 'guest'

  useEffect(() => {
    if (token === undefined) return

    if (guest) {
      stashInviteToken(token)
      router.replace('/login?returnTo=/invite')
      return
    }

    if (!authenticated) return

    // Consumed: from here on the token lives in memory only.
    clearStashedInviteToken()
    window.history.replaceState(null, '', window.location.pathname)

    resolveInvitation(token)
      .then((resolved) => {
        setPhase({ kind: 'resolved', resolved })
      })
      .catch((error: unknown) => {
        setPhase(
          error instanceof ApiRequestError && error.code === 'INVITE_INVALID'
            ? { kind: 'invalid' }
            : { kind: 'error', message: describeError(error) },
        )
      })
  }, [token, guest, authenticated, router])

  async function accept(resolved: ResolveInvitationResponse): Promise<void> {
    if (token === undefined) return

    setPhase({ kind: 'accepting', resolved })

    try {
      const result = await acceptInvitation(token)

      setPhase({ kind: 'accepted', inviter: result.inviter })
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'INVITE_INVALID') {
        setPhase({ kind: 'invalid' })
      } else if (error instanceof ApiRequestError && error.status === 410) {
        setPhase({ kind: 'resolved', resolved: { ...resolved, state: goneState(error.code) } })
      } else {
        setPhase({ kind: 'error', message: describeError(error) })
      }
    }
  }

  return (
    <main className="page page--narrow">
      <h1>Запрошення до BookSwap</h1>
      {session.status === 'error' ? (
        <p className="status status--error" role="alert">
          {session.message}
        </p>
      ) : (
        renderPhase()
      )}
    </main>
  )

  function renderPhase() {
    switch (phase.kind) {
      case 'init':
        return token === undefined && session.status !== 'loading' ? (
          <p className="empty">
            У адресі немає запрошення. Відкрийте посилання, яке вам надіслали, ще раз.
          </p>
        ) : (
          <p className="status status--pending">Перевіряю запрошення…</p>
        )
      case 'invalid':
        return <p className="status status--error">Запрошення недійсне.</p>
      case 'error':
        return (
          <p className="status status--error" role="alert">
            {phase.message}
          </p>
        )
      case 'declined':
        return (
          <p className="empty">
            Добре, дружбу не створено. <Link href="/friends">До друзів</Link>
          </p>
        )
      case 'accepted':
        return (
          <div>
            <p className="status status--success" role="status">
              Тепер ви друзі з {phase.inviter.displayName}.
            </p>
            <p>
              <Link href={`/users/${encodeURIComponent(phase.inviter.id)}/library`}>
                Переглянути бібліотеку
              </Link>{' '}
              · <Link href="/catalog">Доступні від друзів</Link>
            </p>
          </div>
        )
      case 'resolved':
      case 'accepting':
        return renderResolved(phase.resolved, phase.kind === 'accepting')
    }
  }

  function renderResolved(resolved: ResolveInvitationResponse, busy: boolean) {
    const inviter = (
      <p>
        <UserAvatar user={resolved.inviter} /> <strong>{resolved.inviter.displayName}</strong>{' '}
        запрошує вас до BookSwap.
      </p>
    )

    if (resolved.state === 'ACTIVE' && resolved.relation === 'FRIENDS') {
      return (
        <div>
          {inviter}
          <p className="empty">
            Ви вже друзі.{' '}
            <Link href={`/users/${encodeURIComponent(resolved.inviter.id)}/library`}>
              Бібліотека
            </Link>
          </p>
        </div>
      )
    }

    if (resolved.state === 'ACTIVE') {
      return (
        <div>
          {inviter}
          <p className="form__aside">
            Дружба з’явиться лише після вашого підтвердження: тоді ви бачитимете бібліотеки одне
            одного.
          </p>
          <div className="person__actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void accept(resolved)
              }}
            >
              {busy ? 'Приймаю…' : 'Прийняти дружбу'}
            </button>
            <button
              type="button"
              className="button--ghost"
              disabled={busy}
              onClick={() => {
                setPhase({ kind: 'declined' })
              }}
            >
              Не зараз
            </button>
          </div>
        </div>
      )
    }

    return (
      <div>
        {inviter}
        <p className="empty">{TERMINAL_MESSAGES[resolved.state]}</p>
      </div>
    )
  }
}

function goneState(code: string): 'EXPIRED' | 'REVOKED' | 'EXHAUSTED' {
  if (code === 'INVITE_REVOKED') return 'REVOKED'
  if (code === 'INVITE_EXHAUSTED') return 'EXHAUSTED'

  return 'EXPIRED'
}
