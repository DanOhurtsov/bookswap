'use client'

import type { LibraryImportDraftResponse } from '@bookswap/shared'
import type { ImportFailure } from '../model/import-draft-state'

type ImportDraftSummaryProps = {
  draft: LibraryImportDraftResponse
  isCommitting: boolean
  failure: ImportFailure | undefined
  onCommit: () => void
}

/**
 * Stage 8f-3 and 8g: what the server says about this draft — and only what it
 * says.
 *
 * `counts`, `readiness.canCommit` and `readiness.copyCount` are rendered as
 * received. Recomputing readiness in the browser would be a second opinion on a
 * question the server already answers, and the two would drift the first time a
 * rule changes (R7a: `copyCount` may legitimately exceed the 500 cap after an
 * edit, and the honest answer is the real number with `canCommit: false`).
 *
 * 8g adds the same rule to the blocking reasons: `readiness.blockers` comes
 * from the very function the commit endpoint re-runs under its lock, so the
 * sentence under the button and the refusal behind it cannot disagree.
 */
export function ImportDraftSummary({
  draft,
  isCommitting,
  failure,
  onCommit,
}: ImportDraftSummaryProps) {
  const { counts, readiness } = draft
  const attention = counts.needsReview + counts.invalid

  return (
    <section className="import-summary">
      <dl className="facts import-summary__facts">
        <dt>Готові рядки</dt>
        <dd>{counts.readyExistingEdition + counts.readyCreateChain}</dd>
        <dt>Потребують уваги</dt>
        <dd>{attention}</dd>
        <dt>Пропущені</dt>
        <dd>{counts.skipped}</dd>
        <dt>Буде додано примірників</dt>
        <dd>{readiness.copyCount}</dd>
      </dl>

      {readiness.canCommit ? (
        <p className="status status--ok">Чернетка готова до імпорту.</p>
      ) : (
        <p className="status status--pending">{describeNotReady(draft)}</p>
      )}

      {failure !== undefined && (
        <p className="status status--error" role="alert">
          {failureMessage(failure)}
        </p>
      )}

      <div className="import-actions">
        <button
          type="button"
          className="import-action"
          // Disabled while a commit is in flight as well: the hook refuses a
          // second one synchronously anyway, but a button that still looks
          // pressable during a 500-copy import invites the click it will drop.
          disabled={!readiness.canCommit || isCommitting}
          aria-describedby="import-commit-hint"
          onClick={onCommit}
        >
          {isCommitting ? 'Імпортую…' : 'Імпортувати до бібліотеки'}
        </button>
      </div>
      <p className="form__aside" id="import-commit-hint">
        Книжки додаються однією дією: або всі готові рядки, або жодного. Повторне натискання не
        створить других примірників. Чернетка зберігається 24 години, і до неї можна повернутися за
        цим посиланням.
      </p>
    </section>
  )
}

/**
 * Why the button is off, in the server's own terms.
 *
 * The first blocker is shown rather than all of them: they are ordered, the
 * first is the one to act on, and a list of every way a draft is not ready
 * reads as a wall rather than as a next step. The copy cap has no blocker of
 * its own (it keeps `IMPORT_TOO_LARGE`, R6a), so it is spelled out here.
 */
function describeNotReady(draft: LibraryImportDraftResponse): string {
  const { counts, readiness } = draft
  const [blocker] = readiness.blockers

  if (blocker === undefined) {
    return `Примірників у чернетці більше, ніж можна імпортувати за раз: ${String(readiness.copyCount)}.`
  }

  switch (blocker.reason) {
    case 'NOTHING_TO_IMPORT':
      return 'Імпортувати поки нічого: усі рядки пропущено.'
    case 'CONFLICTING_EDITION_ROWS':
      return `Кілька рядків описують той самий ISBN по-різному (${describeRows(blocker.rowNumbers)}). Зведіть їх до одного опису або пропустіть зайві.`
    default:
      return `Ще треба розібратися з рядками: ${String(counts.needsReview + counts.invalid)}.`
  }
}

function describeRows(rowNumbers: readonly number[]): string {
  const shown = rowNumbers.slice(0, 5).map(String).join(', ')

  return rowNumbers.length > 5 ? `рядки ${shown} й інші` : `рядки ${shown}`
}

function failureMessage(failure: ImportFailure): string {
  switch (failure.kind) {
    case 'not-ready':
    case 'rate-limited':
    case 'file':
    case 'other':
      return failure.message
    case 'conflict':
      return 'Чернетка змінилася після того, як ви її прочитали. Перечитайте її й повторіть імпорт.'
    default:
      return 'Імпорт не вдався. Спробуйте ще раз.'
  }
}
