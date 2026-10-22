'use client'

import Link from 'next/link'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { formatDate, GUEST_EVIDENCE_LABELS, LOAN_STATUS_LABELS } from '@/app/lib/labels'
import { useMyHistory } from '@/app/lib/use-history'
import { toLoanHistory, type HistoryDirection, type LoanHistoryRow } from '../model/loan-history'

const DIRECTION_LABELS: Readonly<Record<HistoryDirection, string>> = {
  borrowed: 'Ви позичили',
  lent: 'Ви дали почитати',
}

const COUNTERPART_LABELS: Readonly<Record<LoanHistoryRow['counterpart']['side'], string>> = {
  owner: 'Власник',
  borrower: 'Позичальник',
}

const UNKNOWN_DATE = 'не вказано'

/**
 * §6.6, personal history: one list of what I borrowed and what I lent (BS-142). Mounted only on the
 * «Історія» tab, and it reads `GET /me/history` — never the current loans list.
 *
 * Names come only from the API: a registered side of my own loan is always named, a guest record
 * carries none, and nothing here fills that gap.
 */
export function LoansHistoryPanel() {
  const { state } = useMyHistory()

  if (state.status === 'loading') return <p className="status status--pending">Завантажую…</p>
  if (state.status === 'error') return <FormStatus error={new Error(state.message)} />

  const rows = toLoanHistory(state.data)

  if (rows.length === 0) return <p className="empty">Історія позичань поки порожня.</p>

  return (
    <ul className="books" aria-label="Історія позичань">
      {rows.map((row) => (
        <HistoryRow key={row.key} row={row} />
      ))}
    </ul>
  )
}

function HistoryRow({ row }: { row: LoanHistoryRow }) {
  const { entry, copy, counterpart } = row

  return (
    <li className="book">
      <Link className="book__title" href={`/works/${copy.work.id}`}>
        {copy.work.title}
      </Link>
      <AuthorLine authors={copy.authors} />
      <EditionLine edition={copy.edition} />

      <span className="book__meta">
        {DIRECTION_LABELS[row.direction]} · {COUNTERPART_LABELS[counterpart.side]}:{' '}
        {counterpart.name ?? 'гість, ім’я не показується'}
      </span>
      <span className="book__meta">
        Статус: {LOAN_STATUS_LABELS[entry.status]}
        {/* `dueAt` is the agreed term, not a return: it is labelled as such. */}
        {entry.dueAt !== null && ` · строк повернення до ${formatDate(entry.dueAt)}`}
        {entry.isOverdue && ' · прострочено'}
      </span>
      <span className="book__meta">
        Передано: {dateOrUnknown(entry.handedAt)} · Повернено: {dateOrUnknown(entry.returnedAt)}
        {row.showsCompletedAt && ` · Завершено: ${dateOrUnknown(row.completedAt)}`}
      </span>
      <span className="book__meta">{originLine(row)}</span>

      <span className="book__meta">
        <Link href={`/copies/${copy.id}/history`}>Уся історія примірника</Link>
      </span>
    </li>
  )
}

function dateOrUnknown(iso: string | null): string {
  return iso === null ? UNKNOWN_DATE : formatDate(iso)
}

/**
 * Whether there was a request comes from `origin`, not `requestedAt`: the DB defaults it to now(),
 * so a loan the owner recorded may carry a `requestedAt` nobody sent.
 */
function originLine({ entry }: LoanHistoryRow): string {
  const parts = [
    entry.origin !== 'REQUESTED'
      ? 'Записано власником'
      : `Попросили ${dateOrUnknown(entry.requestedAt)}`,
  ]

  // Stage 10 (10i.3): where a guest handover's evidence comes from — no private data of the guest.
  if (entry.guestEvidence !== null) {
    parts.push(`джерело: ${GUEST_EVIDENCE_LABELS[entry.guestEvidence]}`)
  }

  return parts.join(' · ')
}
