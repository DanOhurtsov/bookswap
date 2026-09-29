'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import type { GuestLoan, GuestLoanAction } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, describeError } from '@/app/lib/api'
import {
  CONDITION_LABELS,
  GUEST_EVIDENCE_LABELS,
  LOAN_STATUS_LABELS,
  formatDate,
} from '@/app/lib/labels'
import { useGuestLoan, useGuestLoans } from '@/app/lib/use-guest-loans'
import { actOnGuestLoan } from '../api/guest-loans-requests'
import { GuestConfirmationsSection, SingleGuestConfirmationView } from './GuestConfirmationsSection'
import { GuestLoanActions } from './GuestLoanActions'

/**
 * Stage 10 (10f.3): owner-only список і деталі гостьових позик — `alias`/`contactId` цим екраном
 * і тримається (D4, P1/P2): жоден загальний компонент історії/позичань цих полів не отримує.
 *
 * `useSearchParams` вимагає межі `Suspense` — той самий прийом, що на `/loans` (реєстрований флоу).
 */
export function GuestLoansScreen() {
  return (
    <Suspense fallback={<p className="status status--pending">Завантажую…</p>}>
      <GuestLoansBody />
    </Suspense>
  )
}

function GuestLoansBody() {
  const parameters = useSearchParams()
  const loanId = parameters.get('loanId')
  const confirmationId = parameters.get('confirmationId')

  if (loanId !== null) return <SingleGuestLoanView loanId={loanId} />

  // 10i.3: один запит підтвердження (з посилання сповіщення про відповідь гостя).
  if (confirmationId !== null) {
    return (
      <>
        <SyntheticDataNotice />
        <SingleGuestConfirmationView confirmationId={confirmationId} />
        <Footer />
      </>
    )
  }

  return <GuestLoanListView />
}

/**
 * Спільна механіка дій. Item 5 (10f.3 web-рев'ю): на відміну від реєстрованого `useLoanActions`,
 * тут перечитуємо дані і на успіху, і на ПОМИЛЦІ — конкурентна дія (409, хтось інший чи інша вкладка
 * змінили стан) має відразу показати свіжу картку, а не лишати застарілу поряд із текстом помилки.
 */
function useGuestLoanActions(reload: () => Promise<void>) {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      // І на успіху, і на помилці: захист від повторного submit тримає лише `busyKey`
      // упродовж запиту, а свіжі дані потрібні в обох випадках.
      await reload()
      setBusyKey(undefined)
    }
  }

  const act = (
    loan: GuestLoan,
    action: GuestLoanAction,
    body: Record<string, unknown> = {},
  ): Promise<void> =>
    run(`${action}:${loan.id}`, async () => {
      await actOnGuestLoan(loan.id, { action, ...body })
    })

  return { failure, busyKey, act }
}

type GuestLoanActions_ = ReturnType<typeof useGuestLoanActions>

function GuestLoanListView() {
  const { state, reload } = useGuestLoans()
  const actions = useGuestLoanActions(reload)

  return (
    <>
      <SyntheticDataNotice />

      {/* 10i.3: запити підтвердження — окремий ресурс (`/guest-loan-confirmations`), не частина цього списку. */}
      <GuestConfirmationsSection />

      <h2>Гостьові позики</h2>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.loans.length === 0 && (
        <p className="empty">
          Гостьових позик поки немає. Записати можна з картки примірника в{' '}
          <Link href="/library">бібліотеці</Link>.
        </p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.loans.map((loan) => (
            <GuestLoanCard
              key={loan.id}
              loan={loan}
              busyKey={actions.busyKey}
              onAct={actions.act}
            />
          ))}
        </ul>
      )}

      <Footer />
    </>
  )
}

/** `GET /loans/guest/:id`. Чужа, неіснуюча й синтетична позика API віддає як 404. */
function SingleGuestLoanView({ loanId }: { loanId: string }) {
  const { state, reload } = useGuestLoan(loanId)
  const actions = useGuestLoanActions(reload)

  return (
    <>
      <SyntheticDataNotice />

      <p className="form__aside">
        Одна гостьова позика. <Link href="/loans/guest">Показати всі</Link>
      </p>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && (
        <>
          <FormStatus error={new Error(state.message)} />
          <p className="empty">Можливо, цієї позики більше немає або вона вам не належить.</p>
        </>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          <GuestLoanCard loan={state.data.loan} busyKey={actions.busyKey} onAct={actions.act} />
        </ul>
      )}

      <Footer />
    </>
  )
}

function SyntheticDataNotice() {
  return (
    <div className="alert alert--warn" role="note">
      <p>
        <strong>Лише синтетичні тестові дані.</strong> Не вводьте справжні імена чи контакти людей.
      </p>
    </div>
  )
}

function Footer() {
  return (
    <p className="form__aside">
      <Link href="/contacts">Контакти</Link> · <Link href="/library">Моя бібліотека</Link> ·{' '}
      <Link href="/loans">Позичання</Link> · <Link href="/">На головну</Link>
    </p>
  )
}

function GuestLoanCard({
  loan,
  busyKey,
  onAct,
}: {
  loan: GuestLoan
  busyKey: string | undefined
  onAct: GuestLoanActions_['act']
}) {
  return (
    <li className="book">
      <Link className="book__title" href={`/works/${loan.work.id}`}>
        {loan.work.title}
      </Link>
      <AuthorLine authors={loan.authors} />
      <EditionLine edition={loan.edition} />

      <span className="book__meta">
        {LOAN_STATUS_LABELS[loan.status]} · {CONDITION_LABELS[loan.copy.condition]} · гість:{' '}
        {/* Item 3 (10f.3 web-рев'ю): контакт стерто (D3/Q3d) — факт позики лишається, alias зникає. */}
        {loan.contact === null ? 'контакт видалено' : loan.contact.alias}
        {loan.dueAt !== null && ` · до ${formatDate(loan.dueAt)}`}
        {loan.isOverdue && ' · прострочено'}
      </span>

      <span className="book__meta">
        Передано {formatDate(loan.handedAt)}
        {loan.returnedAt !== null && ` · повернено ${formatDate(loan.returnedAt)}`}
      </span>

      {/* 10i.3: джерело факту окремо від статусу. Ручні записи 10f.3 лишаються «зі слів власника»
          і не стають підтвердженими заднім числом. */}
      <span className="book__meta">
        Джерело факту передачі: <strong>{GUEST_EVIDENCE_LABELS[loan.evidence]}</strong>
      </span>

      <GuestLoanActions loan={loan} busy={busyKey !== undefined} busyKey={busyKey} onAct={onAct} />

      <span className="book__meta">
        <Link href={`/copies/${loan.copy.id}/history`}>Історія примірника</Link>
      </span>
    </li>
  )
}
