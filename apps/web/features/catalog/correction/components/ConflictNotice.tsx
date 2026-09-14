'use client'

import type { ReactNode } from 'react'

type ConflictNoticeProps = {
  children: ReactNode
  onRetry: () => void
}

/**
 * R9/R12: `409 CATALOG_REVISION_CONFLICT` never overwrites someone else's
 * change silently, and never throws away what the user typed. This shows the
 * fresh server values (`children`) next to the still-intact form and leaves
 * the decision to the person: retry (now targeting the fresh revision) or
 * keep editing/cancel.
 */
export function ConflictNotice({ children, onRetry }: ConflictNoticeProps) {
  return (
    <div className="alert alert--warn" role="alert">
      <p>Дані вже змінив хтось інший, поки ви редагували. Ваш ввід нижче не втрачено.</p>
      {children}
      <div className="person__actions">
        <button type="button" onClick={onRetry}>
          Зберегти мої зміни поверх
        </button>
      </div>
    </div>
  )
}
