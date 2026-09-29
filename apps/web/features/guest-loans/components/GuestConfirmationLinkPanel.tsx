'use client'

import { useState } from 'react'
import {
  GUEST_INVITATION_EMAIL_DOMAIN,
  GUEST_LINK_TTL_DAYS,
  guestInvitationEmailSchema,
  type GuestConfirmationLink,
} from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { formatDateTime } from '@/app/lib/labels'
import { validate } from '@/app/lib/validation'

/**
 * Що власник щойно зробив із посиланням — лише в пам'яті цієї сторінки. Токен приходить у відповіді
 * `COPY` один раз (у БД лише геш), тож після перезавантаження його вже не побачити.
 */
export type IssuedLink = { delivery: 'COPY'; url: string } | { delivery: 'EMAIL' }

interface GuestConfirmationLinkPanelProps {
  confirmationId: string
  link: GuestConfirmationLink
  /** Щойно видане посилання (лише цієї сесії сторінки). */
  issued: IssuedLink | undefined
  busy: boolean
  busyKey: string | undefined
  onIssue: (body: { delivery: 'COPY' } | { delivery: 'EMAIL'; email: string }) => Promise<boolean>
}

/**
 * Stage 10 (10i.3): видача посилання підтвердження — два шляхи (COPY і тестовий EMAIL).
 *
 * Тексти тут навмисно точні щодо трьох речей: (1) повторна видача гасить старе посилання одразу;
 * (2) адреса листа — лише для відправки (не зберігається й не називається email гостя; гість підтверджує
 * будь-яку СВОЮ адресу, з адресою доставки її не порівнюють); (3) тестовий транспорт нічого назовні не
 * доставляє — інтерфейс не стверджує, що реальна людина отримала лист (D2).
 */
export function GuestConfirmationLinkPanel({
  confirmationId,
  link,
  issued,
  busy,
  busyKey,
  onIssue,
}: GuestConfirmationLinkPanelProps) {
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string>()
  const [copied, setCopied] = useState<'ok' | 'failed'>()

  const hasLink = link !== null
  const copyKey = `link-copy:${confirmationId}`
  const emailKey = `link-email:${confirmationId}`

  async function sendEmail(): Promise<void> {
    const result = validate(guestInvitationEmailSchema, email)

    if (!result.ok) {
      setEmailError(result.errors.form ?? 'Некоректна адреса')
      return
    }

    setEmailError(undefined)

    if (await onIssue({ delivery: 'EMAIL', email: result.data })) setEmail('')
  }

  async function copyToClipboard(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="form" aria-label="Посилання для гостя">
      <p className="book__meta" data-testid="link-state">
        {link === null && 'Посилання ще не видавалося (або вже погашене).'}
        {link !== null && !link.isExpired && `Посилання діє до ${formatDateTime(link.expiresAt)}.`}
        {link !== null &&
          link.isExpired &&
          `Строк дії посилання минув ${formatDateTime(link.expiresAt)}. Запит НЕ закрито: отримання не підтверджене, примірник лишається недоступним. Видайте нове посилання або закрийте запит діями нижче.`}
      </p>

      <p className="form__aside">
        Посилання діє {GUEST_LINK_TTL_DAYS} днів від видачі. Повторна видача гасить попереднє
        посилання: старе перестане працювати одразу.
      </p>

      <div className="person__actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setCopied(undefined)
            void onIssue({ delivery: 'COPY' })
          }}
        >
          {busyKey === copyKey
            ? 'Видаю…'
            : hasLink
              ? 'Видати нове посилання (скопіювати)'
              : 'Видати посилання (скопіювати)'}
        </button>
      </div>

      {issued?.delivery === 'COPY' && (
        <div className="alert alert--ok" role="status">
          <p>
            Нове посилання видано. Передайте його гостю самі. Воно показується лише зараз — якщо
            втратите, видайте нове (це погасить це).
          </p>
          <input
            type="text"
            readOnly
            aria-label="Посилання для гостя"
            value={issued.url}
            onFocus={(event) => {
              event.currentTarget.select()
            }}
          />
          <button
            type="button"
            className="button--ghost"
            onClick={() => {
              void copyToClipboard(issued.url)
            }}
          >
            Скопіювати
          </button>
          {copied === 'ok' && <p>Скопійовано.</p>}
          {copied === 'failed' && (
            <p>Не вдалося скопіювати автоматично — виділіть і скопіюйте вручну.</p>
          )}
        </div>
      )}

      <TextField
        id={`guest-link-email-${confirmationId}`}
        label="Тестовий лист: адреса доставки"
        type="email"
        placeholder={`name@${GUEST_INVITATION_EMAIL_DOMAIN}`}
        hint={`Лише для відправки листа з посиланням (тільки синтетичний домен ${GUEST_INVITATION_EMAIL_DOMAIN}). Адреса не зберігається й не вважається email гостя: гість підтверджує будь-яку СВОЮ адресу.`}
        error={emailError}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value)
        }}
      />
      <div className="person__actions">
        <button
          type="button"
          className="button--ghost"
          disabled={busy}
          onClick={() => {
            void sendEmail()
          }}
        >
          {busyKey === emailKey
            ? 'Надсилаю…'
            : hasLink
              ? 'Надіслати нове посилання листом'
              : 'Надіслати посилання листом'}
        </button>
      </div>

      {issued?.delivery === 'EMAIL' && (
        <div className="alert alert--warn" role="status">
          <p>
            Посилання передано в тестовий поштовий транспорт. Він нічого не доставляє назовні: жодна
            реальна людина листа не отримала. Адресу доставки не збережено.
          </p>
        </div>
      )}
    </div>
  )
}
