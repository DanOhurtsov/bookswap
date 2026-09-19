'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  LIBRARY_IMPORT_CSV_HEADER,
  libraryImportCsvCellsSchema,
  type LibraryImportCsvCells,
  type LibraryImportCsvColumn,
  type LibraryImportRowResponse,
} from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { IMPORT_COLUMN_LABELS } from '../model/import-labels'
import type { ConfirmedRowAction } from '../model/use-library-import-draft'

type ImportRowEditFormProps = {
  row: LibraryImportRowResponse
  isPending: boolean
  /** True while this row's last action failed with `IMPORT_ROW_CONFLICT`. */
  hasConflict: boolean
  /** This row's most recently confirmed action, or `undefined` if there is none. */
  confirmed: ConfirmedRowAction | undefined
  /**
   * False while the draft on screen is known-stale — a conflict whose re-read
   * has not landed yet. Re-applying then would target a version nobody has
   * seen, so the offer is withheld rather than guessed at.
   */
  canReapply: boolean
  onSubmit: (input: { cells: Partial<LibraryImportCsvCells>; expectedRowVersion: string }) => void
  onClose: () => void
}

/**
 * Stage 8f-3: correct a row by its raw CSV cells.
 *
 * Every supported column is editable, because every server-side row error names
 * a column and a person must be able to fix the one they were told about —
 * `MISSING_CATALOG_DATA` can ask for `orig_lang`, `INVALID_FIELD` for
 * `page_count`, and a form offering only ISBN and title would leave them stuck.
 *
 * Values stay raw strings on purpose. They go back through the very same cell
 * schemas the file went through (R7a), so an edit cannot produce a state a CSV
 * could not — and the browser adds no normalization of its own that nobody
 * agreed to.
 */
export function ImportRowEditForm({
  row,
  isPending,
  hasConflict,
  confirmed,
  canReapply,
  onSubmit,
  onClose,
}: ImportRowEditFormProps) {
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<LibraryImportCsvCells>({
    resolver: zodResolver(libraryImportCsvCellsSchema),
    defaultValues: row.cells,
  })

  /**
   * The row state this form is acting on.
   *
   * NOT read from `row` on every render: a background refresh that moved
   * `rowVersion` under a half-typed form would make the next PATCH silently
   * claim to act on a state nobody ever looked at, which is exactly the
   * confusion `expectedRowVersion` exists to prevent (R7a). It moves forward
   * for exactly two reasons, both of them the user's own doing: this form's own
   * save was confirmed, or they explicitly chose to re-apply after a conflict.
   */
  const [baseline, setBaseline] = useState(row.rowVersion)
  /**
   * The cells this form's *unsent intent* is measured against — what "I changed
   * this field" means right now. It advances with a confirmed save (the server
   * now holds what we sent, so only later typing is still unsent) and, crucially,
   * NOT on a conflict: after a 409 the row moved because somebody else changed
   * it, and re-measuring the intent against their values would turn their edits
   * into ours and quietly undo them.
   */
  const seededCells = useRef<LibraryImportCsvCells>(row.cells)
  /**
   * The form exactly as it stood when the pending save was sent.
   *
   * Distinct from `seededCells`, and it has to be: the seed answers "what is
   * stored", this answers "what did I send". Only the second one can tell
   * whether a field changed AFTER the request left — and a person who types a
   * value, saves, then types the ORIGINAL value back has done exactly that,
   * while still matching the seed byte for byte.
   */
  const sentCells = useRef<LibraryImportCsvCells | undefined>(undefined)
  const headingRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  /**
   * Seeded with whatever was already confirmed at mount, so a REOPENED form
   * does not treat an older save as its own — the same guard the catalog
   * correction forms use around `CatalogCorrection.confirmed` (8e-3).
   */
  const appliedConfirmation = useRef(confirmed)

  useEffect(() => {
    if (confirmed === undefined) return
    if (confirmed.id === appliedConfirmation.current?.id) return

    appliedConfirmation.current = confirmed

    /**
     * The save landed, so the intent baseline advances to what the server now
     * holds. The form has to move with it, or the two drift apart: a field the
     * person never touched would keep the value it had when the form opened,
     * and from the next save on it would read as a fresh edit of theirs.
     *
     * That is not hypothetical — it is precisely what a re-apply after a `409`
     * causes. The re-applied edit lands on top of somebody else's change, so
     * the confirmed row carries THEIR value in a field this person never
     * opened, while the form still shows the value from before their change.
     *
     * So each field is decided separately, on the one question that matters:
     * has this person changed it since the save went out?
     *
     * - No — adopt the confirmed value. It is the truth now, and adopting it is
     *   what stops it being re-sent as an edit later.
     * - Yes — keep what they typed. That text is newer than the request and was
     *   never part of it, so it is still unsent and still theirs to send.
     *
     * The comparison is against what was SENT, not against the stored baseline,
     * because those two differ in the case that matters most: typing `B`,
     * saving, then typing `A` back leaves the field equal to the baseline while
     * being very much a deliberate change. Comparing to the baseline would call
     * it untouched and overwrite the revert with the `B` that just landed. With
     * no save of our own outstanding (a `SKIP` on this row, say) there is
     * nothing sent to compare against, and the baseline is the right reference.
     */
    const reference = sentCells.current ?? seededCells.current
    const current = getValues()

    for (const column of LIBRARY_IMPORT_CSV_HEADER) {
      if (current[column] !== reference[column]) continue

      setValue(column, row.cells[column], { shouldDirty: false })
    }

    seededCells.current = row.cells
    sentCells.current = undefined
    setBaseline(row.rowVersion)
  }, [confirmed, row.rowVersion, row.cells, getValues, setValue])

  function changedCells(values: LibraryImportCsvCells): Partial<LibraryImportCsvCells> {
    const changed: Partial<LibraryImportCsvCells> = {}

    for (const column of LIBRARY_IMPORT_CSV_HEADER) {
      if (values[column] !== seededCells.current[column]) changed[column] = values[column]
    }

    return changed
  }

  function submit(values: LibraryImportCsvCells, expectedRowVersion: string): void {
    const cells = changedCells(values)

    // The shared contract refuses an edit with no cells, and so does this: an
    // empty PATCH would mint a new `rowVersion` for nothing.
    if (Object.keys(cells).length === 0) {
      onClose()

      return
    }

    // Remembered before the request leaves, so that whatever is typed from now
    // on is recognisable as newer than it.
    sentCells.current = values
    onSubmit({ cells, expectedRowVersion })
  }

  /**
   * The explicit "apply anyway" after a 409 — never automatic (R7a).
   *
   * Only `expectedRowVersion` moves forward. The intent baseline stays where it
   * was, so what gets re-sent is what this person actually edited and nothing
   * else: a field the other tab changed and this person never touched is not
   * part of "my changes" and must not ride along.
   */
  function reapply(): void {
    setBaseline(row.rowVersion)
    void handleSubmit((values) => {
      submit(values, row.rowVersion)
    })()
  }

  return (
    <div className="import-row__panel">
      <p className="import-row__panel-title" tabIndex={-1} ref={headingRef}>
        Рядок {row.rowNumber}: виправлення
      </p>

      {hasConflict && (
        <div className="alert alert--warn" role="alert">
          <p>
            Цей рядок змінився, поки ви його редагували. Ваш текст нижче не втрачено, але його ще не
            застосовано.
          </p>
          <div className="import-actions">
            <button
              type="button"
              className="import-action"
              disabled={isPending || !canReapply}
              onClick={reapply}
            >
              Застосувати мої зміни до оновленого рядка
            </button>
          </div>
          {!canReapply && (
            <p className="book__meta">Спершу треба дочитати оновлений рядок із сервера.</p>
          )}
        </div>
      )}

      <form
        className="form"
        noValidate
        onSubmit={(event) =>
          void handleSubmit((values) => {
            submit(values, baseline)
          })(event)
        }
      >
        {LIBRARY_IMPORT_CSV_HEADER.map((column: LibraryImportCsvColumn) => (
          <TextField
            key={column}
            id={`import-row-${String(row.rowNumber)}-${column}`}
            label={IMPORT_COLUMN_LABELS[column]}
            autoComplete="off"
            error={errors[column]?.message}
            {...register(column)}
          />
        ))}

        <div className="import-actions">
          <button type="submit" className="import-action" disabled={isPending}>
            {isPending ? 'Зберігаю…' : 'Зберегти рядок'}
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
