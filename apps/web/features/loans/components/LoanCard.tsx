'use client'

import Link from 'next/link'
import type { Loan, LoanAction } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { CONDITION_LABELS, LOAN_STATUS_LABELS, formatDate } from '@/app/lib/labels'
import { counterpartOf } from '@/app/lib/use-loans'
import type { Confirmation } from '../model/use-loan-actions'
import { LoanActions } from './LoanCardActions'

type LoanCardProps = {
  loan: Loan
  userId: string
  busyKey: string | undefined
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
  onConfirm: (confirmation: Confirmation) => void
}

export function LoanCard({ loan, userId, busyKey, onAct, onConfirm }: LoanCardProps) {
  const isOwner = loan.owner.id === userId
  const counterpart = counterpartOf(loan, userId)

  return (
    <li className="book">
      <Link className="book__title" href={`/works/${loan.work.id}`}>
        {loan.work.title}
      </Link>
      <AuthorLine authors={loan.authors} />
      <EditionLine edition={loan.edition} />

      <span className="book__meta">
        {LOAN_STATUS_LABELS[loan.status]} · {CONDITION_LABELS[loan.copy.condition]} ·{' '}
        {counterpartLine(loan, isOwner)} {counterpart.displayName}
        {loan.dueAt !== null && ` · до ${formatDate(loan.dueAt)}`}
        {loan.isOverdue && ' · прострочено'}
      </span>

      {/* The caption comes from `origin`, not `requestedAt`: a loan the owner recorded had no request. */}
      {loan.origin === 'RECORDED_EXISTING' ? (
        <span className="book__meta">
          Записано власником {formatDate(loan.createdAt)}
          {loan.handedAt !== null && ` · передано ${formatDate(loan.handedAt)}`}
        </span>
      ) : (
        loan.requestedAt !== null && (
          <span className="book__meta">Попросили {formatDate(loan.requestedAt)}</span>
        )
      )}

      {loan.message !== null && <span className="book__meta">Прохання: {loan.message}</span>}
      {loan.responseNote !== null && (
        <span className="book__meta">Відповідь: {loan.responseNote}</span>
      )}

      <LoanActions
        loan={loan}
        isOwner={isOwner}
        busyKey={busyKey}
        onAct={onAct}
        onConfirm={onConfirm}
      />

      <span className="book__meta">
        <Link href={`/copies/${loan.copy.id}/history`}>Історія примірника</Link>
      </span>
    </li>
  )
}

/** The counterpart's caption: a loan the owner recorded is not a "request" — `origin` decides. */
function counterpartLine(loan: Loan, isOwner: boolean): string {
  if (loan.origin === 'RECORDED_EXISTING') return isOwner ? 'у друга:' : 'власник:'

  return isOwner ? 'просить' : 'у'
}
