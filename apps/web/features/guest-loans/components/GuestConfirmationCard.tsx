'use client'

import Link from 'next/link'
import type { GuestLoanConfirmation, UpdateGuestLoanConfirmationRequest } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import {
  CONDITION_LABELS,
  GUEST_CONFIRMATION_STATUS_LABELS,
  GUEST_EVIDENCE_LABELS,
  formatDate,
  formatDateTime,
} from '@/app/lib/labels'
import { GuestConfirmationActions } from './GuestConfirmationActions'
import { GuestConfirmationLinkPanel, type IssuedLink } from './GuestConfirmationLinkPanel'

interface GuestConfirmationCardProps {
  confirmation: GuestLoanConfirmation
  busyKey: string | undefined
  issued: IssuedLink | undefined
  onAct: (
    confirmation: GuestLoanConfirmation,
    body: UpdateGuestLoanConfirmationRequest,
  ) => Promise<void>
  onIssue: (
    confirmation: GuestLoanConfirmation,
    body: { delivery: 'COPY' } | { delivery: 'EMAIL'; email: string },
  ) => Promise<boolean>
}

/**
 * Stage 10 (10i.3): картка запиту підтвердження гостьової позики (owner-only).
 *
 * Джерело факту показується окремо від статусу («зі слів власника» / «очікуємо відповідь гостя» /
 * «підтверджено гостем» / «гість заперечує»). Нікнейм і email гостя (підтверджені ним, не адреса доставки)
 * бачить лише власник — тут, у приватному контексті контакту; alias власника не змінюється.
 */
export function GuestConfirmationCard({
  confirmation,
  busyKey,
  issued,
  onAct,
  onIssue,
}: GuestConfirmationCardProps) {
  const { work, contact, loan, link, status, evidence } = confirmation
  const busy = busyKey !== undefined

  return (
    <li className="book" data-confirmation-status={status}>
      <Link className="book__title" href={`/works/${work.id}`}>
        {work.title}
      </Link>
      <AuthorLine authors={confirmation.authors} />
      <EditionLine edition={confirmation.edition} />

      <span className="book__meta">
        {GUEST_CONFIRMATION_STATUS_LABELS[status]} · {CONDITION_LABELS[confirmation.copy.condition]}{' '}
        · гість: {contact === null ? 'контакт видалено' : contact.alias}
      </span>

      <span className="book__meta">
        Джерело факту передачі:{' '}
        <strong>
          {evidence === null ? 'передачу скасовано, факту немає' : GUEST_EVIDENCE_LABELS[evidence]}
        </strong>
        {' · '}Передано {formatDate(loan.handedAt)}
      </span>

      {status === 'OPEN' && (
        <>
          <div className="alert alert--warn" role="note">
            <p>
              Отримання гостем <strong>ще не підтверджене</strong>. Мовчання його не підтверджує, а
              строк дії посилання його не закриває. Примірник лишається недоступним для нових позик,
              доки гість не відповість або ви не закриєте запит.
            </p>
          </div>
          <GuestConfirmationLinkPanel
            confirmationId={confirmation.id}
            link={link}
            issued={issued}
            busy={busy}
            busyKey={busyKey}
            onIssue={(body) => onIssue(confirmation, body)}
          />
        </>
      )}

      {status === 'DENIED' && (
        <div className="alert alert--warn" role="alert">
          <p>
            Гість відповів «Не отримував». Це <strong>розбіжність</strong>, а не повернення:
            примірник сам не звільняється й лишається недоступним. Нове посилання для цієї відповіді
            не видається. Оберіть, що з цим робити:
          </p>
          <ul>
            <li>
              книжка в вас, а передачу записано помилково — скасуйте передачу (лише тоді примірник
              знову стане доступним);
            </li>
            <li>
              книжки в вас немає — залиште запис зі слів власника й окремо зафіксуйте повернення чи
              втрату.
            </li>
          </ul>
        </div>
      )}

      {(status === 'RECEIVED' || status === 'DENIED') && contact !== null && (
        <GuestPrivateDetails contact={contact} />
      )}

      {status === 'RECEIVED' && (
        <span className="book__meta">
          Гість підтвердив отримання{' '}
          {confirmation.resolvedAt !== null && formatDateTime(confirmation.resolvedAt)}: відповідь
          через посилання після підтвердження контролю введеного ним email. Посилання можна передати
          іншій людині, тож це не доводить особу первісного адресата.{' '}
          <Link href={`/loans/guest?loanId=${loan.id}`}>Відкрити позику</Link>
        </span>
      )}

      {status === 'OWNER_RECORDED' && (
        <span className="book__meta">
          Залишено зі слів власника. Це не відповідь гостя й не його підтвердження.{' '}
          <Link href={`/loans/guest?loanId=${loan.id}`}>Відкрити позику</Link>
        </span>
      )}

      {status === 'CANCELLED' && (
        <span className="book__meta">Помилкову передачу скасовано: примірник знову доступний.</span>
      )}

      <GuestConfirmationActions
        confirmation={confirmation}
        busy={busy}
        busyKey={busyKey}
        onAct={onAct}
      />

      <span className="book__meta">
        <Link href={`/copies/${confirmation.copy.id}/history`}>Історія примірника</Link>
      </span>
    </li>
  )
}

function GuestPrivateDetails({
  contact,
}: {
  contact: NonNullable<GuestLoanConfirmation['contact']>
}) {
  if (contact.guestNickname === null || contact.guestEmail === null) return null

  return (
    <span className="book__meta" data-testid="guest-private-details">
      Приватно для вас — поточні підтверджені дані контакту (не обов’язково з відповіді на цей
      запит): нікнейм «{contact.guestNickname}», email {contact.guestEmail}
      {contact.guestEmailVerifiedAt !== null &&
        `, контроль email підтверджено ${formatDateTime(contact.guestEmailVerifiedAt)}`}
      . Пізніша відповідь цього контакту могла замінити попередні значення. Це не адреса, на яку ви
      надсилали лист, і не зміна вашого alias «{contact.alias}».
    </span>
  )
}
