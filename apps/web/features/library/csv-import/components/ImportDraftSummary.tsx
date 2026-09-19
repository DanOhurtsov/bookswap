'use client'

import type { LibraryImportDraftResponse } from '@bookswap/shared'

type ImportDraftSummaryProps = {
  draft: LibraryImportDraftResponse
}

/**
 * Stage 8f-3: what the server says about this draft — and only what it says.
 *
 * `counts`, `readiness.canCommit` and `readiness.copyCount` are rendered as
 * received. Recomputing readiness in the browser would be a second opinion on a
 * question the server already answers, and the two would drift the first time a
 * rule changes (R7a: `copyCount` may legitimately exceed the 500 cap after an
 * edit, and the honest answer is the real number with `canCommit: false`).
 *
 * The commit button is deliberately inert: `POST .../commit` is 8g's endpoint
 * and does not exist yet. A disabled button with a reason is honest; a button
 * that calls an invented endpoint, or a "Книги додано" message over an import
 * that never happened, would not be.
 */
export function ImportDraftSummary({ draft }: ImportDraftSummaryProps) {
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
        <p className="status status--pending">
          {attention > 0
            ? `Ще треба розібратися з рядками: ${String(attention)}.`
            : 'Імпортувати поки нічого: усі рядки пропущено.'}
        </p>
      )}

      <div className="import-actions">
        <button
          type="button"
          className="import-action"
          disabled
          aria-describedby="import-commit-hint"
        >
          Імпортувати до бібліотеки
        </button>
      </div>
      <p className="form__aside" id="import-commit-hint">
        Саме додавання книжок зʼявиться на наступному підетапі — зараз чернетку можна лише
        підготувати. Вона зберігається 24 години, і до неї можна повернутися за цим посиланням.
      </p>
    </section>
  )
}
