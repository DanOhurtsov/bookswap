'use client'

import type { ImportFailure } from '../model/import-draft-state'

type ImportRefreshNoticeProps = {
  failure: ImportFailure
  onRetry: () => void
}

/**
 * A re-read of the draft failed while the draft is still on screen.
 *
 * Same distinction 8e-3 draws with `RefreshNotice`: "could not refresh" is not
 * "could not save", and it must not be dressed as a fatal error — nothing was
 * lost, the rows are simply older than the server's. Critically, it is a notice
 * *beside* the draft rather than a replacement for it: the screen it would
 * replace may be holding a half-typed correction.
 *
 * Retrying here re-runs the GET only. A PATCH is never repeated on the user's
 * behalf (R7a).
 */
export function ImportRefreshNotice({ failure, onRetry }: ImportRefreshNoticeProps) {
  return (
    <div className="alert alert--warn" role="status">
      <p>
        Не вдалося оновити чернетку
        {'message' in failure ? `: ${failure.message}` : '.'}
      </p>
      <p>Показано останній відомий стан. Нічого з ваших змін не втрачено.</p>
      <div className="import-actions">
        <button type="button" className="import-action button--ghost" onClick={onRetry}>
          Оновити чернетку
        </button>
      </div>
    </div>
  )
}
