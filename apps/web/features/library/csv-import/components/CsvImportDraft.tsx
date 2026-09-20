'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import type { LibraryImportDraftResponse } from '@bookswap/shared'
import {
  IMPORT_ROW_FILTERS,
  IMPORT_ROW_FILTER_LABELS,
  countImportRows,
  rowsAwaitingRetry,
  selectImportRows,
  type ImportRowFilter,
} from '../model/import-draft-state'
import { useLibraryImportDraft } from '../model/use-library-import-draft'
import { ImportDraftSummary } from './ImportDraftSummary'
import { ImportFailureNotice } from './ImportFailureNotice'
import { ImportRefreshNotice } from './ImportRefreshNotice'
import { ImportRowCard } from './ImportRowCard'

type CsvImportDraftProps = {
  importId: string
}

const FILTER_PARAM = 'rows'

/**
 * Stage 8f-3: the preview screen of one import draft.
 *
 * Everything on it comes from the single canonical query
 * `['library-import', importId]` (R12) — the summary, the counts, the readiness
 * banner and the rows are one document, so the table and the banner cannot
 * disagree. The filter is a view over that document, not a query of its own.
 */
export function CsvImportDraft({ importId }: CsvImportDraftProps) {
  const state = useLibraryImportDraft(importId)
  const router = useRouter()
  const searchParams = useSearchParams()
  const filter = toFilter(searchParams.get(FILTER_PARAM))

  if (state.isLoading) {
    return <p className="status status--pending">Завантажую чернетку…</p>
  }

  // Only when there is nothing left to show, or no right to show it. A failed
  // REFRESH over a draft that is already on screen is reported beside it
  // (`ImportRefreshNotice`) rather than replacing it: unmounting here would take
  // an open edit form — and everything typed into it — down with the notice.
  if (state.loadFailure !== undefined) {
    return <ImportFailureNotice failure={state.loadFailure} onRetry={state.refresh} />
  }

  if (state.draft === undefined) {
    return <p className="empty">Чернетки немає.</p>
  }

  if (state.draft.import.status === 'COMMITTED') {
    return <CommittedNotice draft={state.draft} />
  }

  function changeFilter(next: ImportRowFilter): void {
    // §3.8: the open tab lives in the URL, so reloading or sharing the link
    // brings the same view back.
    const params = new URLSearchParams(searchParams.toString())

    params.set(FILTER_PARAM, next)
    router.replace(`/library/imports/${importId}?${params.toString()}`, { scroll: false })
  }

  return (
    <DraftBody draft={state.draft} filter={filter} state={state} onFilterChange={changeFilter} />
  )
}

type DraftBodyProps = {
  draft: LibraryImportDraftResponse
  filter: ImportRowFilter
  state: ReturnType<typeof useLibraryImportDraft>
  onFilterChange: (filter: ImportRowFilter) => void
}

function DraftBody({ draft, filter, state, onFilterChange }: DraftBodyProps) {
  const rows = useMemo(() => selectImportRows(draft, filter), [draft, filter])
  // Rows the refused commit named. Derived from the failure, not from the rows
  // themselves: the server refused on grounds the draft cannot see.
  const awaitingRetry = useMemo(() => rowsAwaitingRetry(state.commitFailure), [state.commitFailure])

  return (
    <>
      {state.refreshFailure !== undefined && (
        <ImportRefreshNotice failure={state.refreshFailure} onRetry={state.refresh} />
      )}

      <ImportDraftSummary
        draft={draft}
        isCommitting={state.isCommitting}
        failure={state.commitFailure}
        onCommit={state.commit}
      />

      <nav className="actions import-filters" aria-label="Фільтр рядків">
        {IMPORT_ROW_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`import-action${filter === value ? '' : ' button--ghost'}`}
            aria-pressed={filter === value}
            onClick={() => {
              onFilterChange(value)
            }}
          >
            {IMPORT_ROW_FILTER_LABELS[value]} ({countImportRows(draft, value)})
          </button>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="empty">{emptyMessage(filter)}</p>
      ) : (
        <ul className="import-rows">
          {rows.map((row) => (
            <ImportRowCard
              key={row.rowNumber}
              row={row}
              isBusy={state.isMutating}
              isPending={state.pendingRowNumber === row.rowNumber}
              failure={state.failedRowNumber === row.rowNumber ? state.actionFailure : undefined}
              confirmed={
                state.lastConfirmed?.rowNumber === row.rowNumber ? state.lastConfirmed : undefined
              }
              canReapply={state.isDraftCurrent}
              awaitsRetry={awaitingRetry.has(row.rowNumber)}
              onAction={(request) => {
                state.runRowAction({ rowNumber: row.rowNumber, request })
              }}
            />
          ))}
        </ul>
      )}

      <p className="form__aside">
        <Link href="/library/imports">Надіслати інший файл</Link> ·{' '}
        <Link href="/library">Моя бібліотека</Link>
      </p>
    </>
  )
}

function CommittedNotice({ draft }: { draft: LibraryImportDraftResponse }) {
  return (
    <div className="status status--ok" role="status">
      <p>
        Цей імпорт уже завершено
        {draft.import.createdCopyCount === null
          ? '.'
          : `: додано примірників — ${String(draft.import.createdCopyCount)}.`}
      </p>
      <p className="form__aside">
        <Link href="/library">Моя бібліотека</Link>
      </p>
    </div>
  )
}

function emptyMessage(filter: ImportRowFilter): string {
  switch (filter) {
    case 'attention':
      return 'Рядків, що потребують уваги, немає.'
    case 'ready':
      return 'Готових рядків поки немає.'
    case 'skipped':
      return 'Пропущених рядків немає.'
    case 'all':
      return 'У чернетці немає рядків.'
  }
}

function toFilter(value: string | null): ImportRowFilter {
  return IMPORT_ROW_FILTERS.find((filter) => filter === value) ?? 'all'
}
