'use client'

import { useRef, useState } from 'react'
import type { LibraryImportRowPatchRequest, LibraryImportRowResponse } from '@bookswap/shared'
import type { ImportFailure } from '../model/import-draft-state'
import type { ConfirmedRowAction } from '../model/use-library-import-draft'
import {
  IMPORT_ROW_STATUS_BADGES,
  IMPORT_ROW_STATUS_LABELS,
  describeRowError,
} from '../model/import-labels'
import { ImportFailureNotice } from './ImportFailureNotice'
import { ImportRowChooser } from './ImportRowChooser'
import { ImportRowEditForm } from './ImportRowEditForm'

type ImportRowCardProps = {
  row: LibraryImportRowResponse
  /** Any action on this draft is in flight — one at a time, draft-wide. */
  isBusy: boolean
  isPending: boolean
  failure: ImportFailure | undefined
  /** This row's most recently confirmed action — already filtered to this row. */
  confirmed: ConfirmedRowAction | undefined
  canReapply: boolean
  onAction: (request: LibraryImportRowPatchRequest) => void
}

type OpenPanel = 'edit' | 'choose' | undefined

/**
 * Stage 8f-3: one row of the preview.
 *
 * Compact by default and detailed on demand — 200 of these have to stay usable
 * on a phone, and 200 open forms would not be. The status is spelled out in
 * words next to its colour, and every error is a sentence rather than a code.
 */
export function ImportRowCard({
  row,
  isBusy,
  isPending,
  failure,
  confirmed,
  canReapply,
  onAction,
}: ImportRowCardProps) {
  const [panel, setPanel] = useState<OpenPanel>()
  const editRef = useRef<HTMLButtonElement>(null)
  const chooseRef = useRef<HTMLButtonElement>(null)

  const ambiguous = row.errors.find((error) => error.code === 'AMBIGUOUS_CATALOG_MATCH')
  const retryable = row.errors.some((error) => error.code === 'LOOKUP_UNAVAILABLE')
  const hasConflict = failure?.kind === 'conflict'
  const isbn = row.values?.isbn13 ?? row.cells.isbn13
  const title = row.values?.title ?? row.cells.title
  const quantity = row.values?.quantity ?? row.cells.quantity

  function close(focus: HTMLButtonElement | null): void {
    setPanel(undefined)
    focus?.focus()
  }

  return (
    <li className={`import-row import-row--${row.status.toLowerCase()}`}>
      <div className="import-row__head">
        <span className="import-row__number">№{row.rowNumber}</span>
        <span className={`import-row__badge import-row__badge--${row.status.toLowerCase()}`}>
          {IMPORT_ROW_STATUS_BADGES[row.status]}
        </span>
      </div>

      <p className="import-row__title">{title === '' ? 'Без назви' : title}</p>
      <p className="book__meta">
        ISBN {isbn === '' ? '—' : isbn} · примірників: {quantity === '' ? '1' : quantity}
      </p>
      {/* Only when it says more than the badge already does — repeating
          "Потребує уваги" twice in one card is noise, not clarity. */}
      {IMPORT_ROW_STATUS_LABELS[row.status] !== IMPORT_ROW_STATUS_BADGES[row.status] && (
        <p className="book__meta">{IMPORT_ROW_STATUS_LABELS[row.status]}</p>
      )}

      {row.cells.note !== '' && <p className="book__meta">Нотатка: {row.cells.note}</p>}

      {row.errors.length > 0 && (
        <ul className="import-row__errors">
          {row.errors.map((error) => (
            <li key={error.code}>{describeRowError(error)}</li>
          ))}
        </ul>
      )}

      {failure !== undefined && failure.kind !== 'conflict' && (
        <ImportFailureNotice failure={failure} />
      )}

      <div className="import-actions">
        <button
          type="button"
          ref={editRef}
          className="import-action button--ghost"
          aria-expanded={panel === 'edit'}
          disabled={isBusy}
          onClick={() => {
            setPanel(panel === 'edit' ? undefined : 'edit')
          }}
        >
          {panel === 'edit' ? 'Згорнути' : 'Виправити'}
        </button>

        {ambiguous !== undefined && (
          <button
            type="button"
            ref={chooseRef}
            className="import-action button--ghost"
            aria-expanded={panel === 'choose'}
            disabled={isBusy}
            onClick={() => {
              setPanel(panel === 'choose' ? undefined : 'choose')
            }}
          >
            {panel === 'choose' ? 'Згорнути' : 'Обрати твір'}
          </button>
        )}

        {retryable && (
          <button
            type="button"
            className="import-action button--ghost"
            disabled={isBusy}
            onClick={() => {
              onAction({ action: 'RETRY', expectedRowVersion: row.rowVersion })
            }}
          >
            Спробувати знайти ще раз
          </button>
        )}

        {row.status === 'SKIPPED' ? (
          <button
            type="button"
            className="import-action button--ghost"
            disabled={isBusy}
            onClick={() => {
              onAction({ action: 'RESTORE', expectedRowVersion: row.rowVersion })
            }}
          >
            Повернути рядок
          </button>
        ) : (
          <button
            type="button"
            className="import-action button--ghost"
            disabled={isBusy}
            onClick={() => {
              onAction({ action: 'SKIP', expectedRowVersion: row.rowVersion })
            }}
          >
            Пропустити
          </button>
        )}

        {isPending && <span className="book__meta">Зберігаю…</span>}
      </div>

      {panel === 'edit' && (
        <ImportRowEditForm
          row={row}
          isPending={isPending}
          hasConflict={hasConflict}
          confirmed={confirmed}
          canReapply={canReapply}
          onSubmit={({ cells, expectedRowVersion }) => {
            onAction({ action: 'EDIT', expectedRowVersion, cells })
          }}
          onClose={() => {
            close(editRef.current)
          }}
        />
      )}

      {panel === 'choose' && ambiguous?.code === 'AMBIGUOUS_CATALOG_MATCH' && (
        <ImportRowChooser
          row={row}
          candidates={ambiguous.candidates}
          isPending={isPending}
          hasConflict={hasConflict}
          confirmed={confirmed}
          canReapply={canReapply}
          onSubmit={({ workId, expectedRowVersion }) => {
            onAction({ action: 'CHOOSE', expectedRowVersion, workId })
          }}
          onClose={() => {
            close(chooseRef.current)
          }}
        />
      )}
    </li>
  )
}
