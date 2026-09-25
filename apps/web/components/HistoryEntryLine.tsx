'use client'

import type { HistoryEntry } from '@bookswap/shared'
import { formatDate, LOAN_STATUS_LABELS } from '@/app/lib/labels'

/**
 * Один запис історії (§6.6).
 *
 * Іменована й анонімна проєкції розрізняються дискримінантом `names`, тож
 * прочитати ім'я там, де його немає, неможливо навіть на рівні типів: у гілці
 * `false` полів `owner`/`borrower` просто не існує. Фронт нічого не приховує сам —
 * рішення ухвалив сервер за §9, а тут лише два способи це показати.
 */
export function HistoryEntryLine({ entry }: { entry: HistoryEntry }) {
  return (
    <li className="copy">
      <span className="book__meta">
        {LOAN_STATUS_LABELS[entry.status]}
        {entry.names
          ? ` · ${entry.borrower.displayName} у ${entry.owner.displayName}`
          : ' · у когось'}
        {entry.dueAt !== null && ` · до ${formatDate(entry.dueAt)}`}
        {entry.isOverdue && ' · прострочено'}
      </span>
      <span className="book__meta">
        {entry.requestedAt !== null && `Попросили ${formatDate(entry.requestedAt)}`}
        {entry.handedAt !== null && ` · передали ${formatDate(entry.handedAt)}`}
        {entry.returnedAt !== null && ` · повернули ${formatDate(entry.returnedAt)}`}
      </span>
    </li>
  )
}
