'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Invitation, InvitationStatus } from '@bookswap/shared'
import { formatDate } from '@/app/lib/labels'
import { FormStatus } from '@/components/Form/FormStatus'
import { TextField } from '@/components/Form/FormFields'
import { createInvitation, listInvitations, revokeInvitation } from '../api/network-requests'
import { describeInviteError } from '../model/invite-errors'

const STATUS_LABELS: Record<InvitationStatus, string> = {
  ACTIVE: 'чинне',
  EXPIRED: 'строк минув',
  REVOKED: 'відкликано',
  EXHAUSTED: 'вичерпано',
}

const KIND_LABELS = { LINK: 'Посилання', EMAIL: 'Лист' } as const

/**
 * «Запросити друзів»: a link (shown once) or an e-mail, plus my invitations with
 * revoke. The link is built from the token in the create response and is never
 * stored — a refresh hides it.
 */
export function InviteManager() {
  const [invitations, setInvitations] = useState<Invitation[]>()
  const [link, setLink] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [email, setEmail] = useState('')
  const [failure, setFailure] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setInvitations((await listInvitations()).invitations)
    } catch (error) {
      setFailure(new Error(describeInviteError(error)))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    listInvitations(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setInvitations(response.invitations)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(new Error(describeInviteError(error)))
      })

    return () => {
      controller.abort()
    }
  }, [])

  async function run(action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setNotice(undefined)
    setBusy(true)

    try {
      await action()
      await refresh()
    } catch (error) {
      setFailure(new Error(describeInviteError(error)))
    } finally {
      setBusy(false)
    }
  }

  function createLink(): void {
    void run(async () => {
      const { token } = await createInvitation({ kind: 'LINK' })

      setCopied(false)
      setLink(
        token === undefined
          ? undefined
          : `${window.location.origin}/invite#${encodeURIComponent(token)}`,
      )
    })
  }

  function sendEmail(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void run(async () => {
      await createInvitation({ kind: 'EMAIL', email })
      setEmail('')
      setNotice('Якщо адреса коректна, лист із запрошенням уже в дорозі.')
    })
  }

  async function copy(): Promise<void> {
    if (link === undefined) return

    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="friends-section">
      <h2>Запросити друзів</h2>
      <FormStatus error={failure} success={notice} />

      <div className="person__actions">
        <button type="button" disabled={busy} onClick={createLink}>
          Створити посилання
        </button>
      </div>

      {link !== undefined && (
        <div role="status">
          <p>
            <input readOnly aria-label="Посилання-запрошення" value={link} size={40} />{' '}
            <button type="button" onClick={() => void copy()}>
              {copied ? 'Скопійовано' : 'Копіювати'}
            </button>
          </p>
          <p className="form__aside">
            Посилання показується один раз; дійсне 14 днів, до 10 людей.
          </p>
        </div>
      )}

      <form className="form" onSubmit={sendEmail} noValidate>
        <TextField
          id="invite-email"
          label="Запросити поштою"
          type="email"
          autoComplete="off"
          hint="Одноразове запрошення, дійсне 14 днів."
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
        <button type="submit" disabled={busy || email.trim() === ''}>
          Надіслати лист
        </button>
      </form>

      {invitations !== undefined && invitations.length > 0 && (
        <ul className="books">
          {invitations.map((invitation) => (
            <li className="book" key={invitation.id}>
              <span className="book__meta">
                {KIND_LABELS[invitation.kind]} · {STATUS_LABELS[invitation.status]} · прийнято{' '}
                {invitation.acceptedCount}/{invitation.maxUses} · до{' '}
                {formatDate(invitation.expiresAt)}
              </span>
              {invitation.status === 'ACTIVE' && (
                <button
                  type="button"
                  className="button--ghost"
                  disabled={busy}
                  onClick={() => {
                    void run(() => revokeInvitation(invitation.id))
                  }}
                >
                  Відкликати
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
