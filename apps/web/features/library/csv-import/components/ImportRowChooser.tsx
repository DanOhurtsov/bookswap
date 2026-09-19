'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { LibraryImportCandidate, LibraryImportRowResponse } from '@bookswap/shared'
import type { ConfirmedRowAction } from '../model/use-library-import-draft'

type ImportRowChooserProps = {
  row: LibraryImportRowResponse
  candidates: readonly LibraryImportCandidate[]
  isPending: boolean
  hasConflict: boolean
  confirmed: ConfirmedRowAction | undefined
  /** See `ImportRowEditForm`: withheld while the re-read after a conflict is missing. */
  canReapply: boolean
  onSubmit: (input: { workId: string | null; expectedRowVersion: string }) => void
  onClose: () => void
}

/** The sentinel for "create a new Work" — the API's `workId: null` (R7a). */
const NEW_WORK = 'new'

/**
 * Stage 8f-3: settle `AMBIGUOUS_CATALOG_MATCH`.
 *
 * "Create a new one" is a listed choice, not the absence of one, and nothing is
 * preselected: R7a is explicit that even a single candidate has to be confirmed
 * by a person, because a namesake attached silently is far harder to notice and
 * undo than one question is to answer.
 */
export function ImportRowChooser({
  row,
  candidates,
  isPending,
  hasConflict,
  confirmed,
  canReapply,
  onSubmit,
  onClose,
}: ImportRowChooserProps) {
  const [choice, setChoice] = useState<string>()
  // Captured when the panel opened — see `ImportRowEditForm` for why this must
  // not follow a background refresh.
  const [baseline, setBaseline] = useState(row.rowVersion)
  const headingRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // This panel's own confirmed action moves its baseline forward; a foreign
  // refresh does not. Same rule, and same reason, as `ImportRowEditForm`.
  const appliedConfirmation = useRef(confirmed)

  useEffect(() => {
    if (confirmed === undefined) return
    if (confirmed.id === appliedConfirmation.current?.id) return

    appliedConfirmation.current = confirmed
    setBaseline(row.rowVersion)
  }, [confirmed, row.rowVersion])

  function apply(expectedRowVersion: string): void {
    if (choice === undefined) return

    onSubmit({ workId: choice === NEW_WORK ? null : choice, expectedRowVersion })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    apply(baseline)
  }

  function reapply(): void {
    setBaseline(row.rowVersion)
    apply(row.rowVersion)
  }

  return (
    <div className="import-row__panel">
      <p className="import-row__panel-title" tabIndex={-1} ref={headingRef}>
        Рядок {row.rowNumber}: який це твір?
      </p>

      {hasConflict && (
        <div className="alert alert--warn" role="alert">
          <p>Рядок змінився, поки ви обирали. Ваш вибір збережено, але ще не застосовано.</p>
          <div className="import-actions">
            <button
              type="button"
              className="import-action"
              disabled={isPending || !canReapply}
              onClick={reapply}
            >
              Застосувати мій вибір до оновленого рядка
            </button>
          </div>
        </div>
      )}

      <form className="form" onSubmit={submit} noValidate>
        <fieldset className="import-candidates">
          <legend>Схожі твори в каталозі</legend>

          {candidates.map((candidate) => (
            <label className="import-candidate" key={candidate.workId}>
              <input
                type="radio"
                name={`choose-${String(row.rowNumber)}`}
                value={candidate.workId}
                checked={choice === candidate.workId}
                onChange={() => {
                  setChoice(candidate.workId)
                }}
              />
              <span>
                <span className="import-candidate__title">{candidate.title}</span>
                {candidate.authors.length > 0 && (
                  <span className="book__meta">{candidate.authors.join(', ')}</span>
                )}
              </span>
            </label>
          ))}

          <label className="import-candidate">
            <input
              type="radio"
              name={`choose-${String(row.rowNumber)}`}
              value={NEW_WORK}
              checked={choice === NEW_WORK}
              onChange={() => {
                setChoice(NEW_WORK)
              }}
            />
            <span className="import-candidate__title">Це інша книжка — створити новий твір</span>
          </label>
        </fieldset>

        <div className="import-actions">
          <button
            type="submit"
            className="import-action"
            disabled={isPending || choice === undefined}
          >
            {isPending ? 'Зберігаю…' : 'Підтвердити вибір'}
          </button>
          <button
            type="button"
            className="import-action button--ghost"
            disabled={isPending}
            onClick={onClose}
          >
            Скасувати
          </button>
        </div>
      </form>
    </div>
  )
}
