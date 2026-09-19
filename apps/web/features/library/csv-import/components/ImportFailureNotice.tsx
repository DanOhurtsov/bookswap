'use client'

import Link from 'next/link'
import type { ImportFailure } from '../model/import-draft-state'

type ImportFailureNoticeProps = {
  failure: ImportFailure
  /** Re-runs the same request. Absent where repeating it cannot help. */
  onRetry?: () => void
}

/**
 * Every failure state the import UI can be in, each with the one next step that
 * actually helps — and never a generic "спробуйте пізніше" over a problem that
 * has a specific answer.
 *
 * An expired draft in particular is never revived silently: its rows (and the
 * private `note` in them) are already deleted server-side (R6a), so the honest
 * offer is to send the file again, not a spinner pretending to recover.
 */
export function ImportFailureNotice({ failure, onRetry }: ImportFailureNoticeProps) {
  const { title, hint, canRetry } = describe(failure)

  return (
    <div className="alert alert--error" role="alert">
      <p>{title}</p>
      {hint !== undefined && <p>{hint}</p>}

      <div className="import-actions">
        {failure.kind === 'expired' || failure.kind === 'not-found' ? (
          <Link className="import-action import-action--link" href="/library/imports">
            Надіслати файл ще раз
          </Link>
        ) : null}

        {failure.kind === 'unauthorized' && (
          <Link className="import-action import-action--link" href="/login">
            Увійти
          </Link>
        )}

        {canRetry && onRetry !== undefined && (
          <button type="button" className="import-action button--ghost" onClick={onRetry}>
            Спробувати ще раз
          </button>
        )}
      </div>
    </div>
  )
}

interface FailureCopy {
  title: string
  hint?: string
  canRetry: boolean
}

function describe(failure: ImportFailure): FailureCopy {
  switch (failure.kind) {
    case 'not-found':
      return {
        title: 'Чернетку імпорту не знайдено.',
        hint: 'Можливо, посилання застаріле або належить іншому акаунту.',
        canRetry: false,
      }
    case 'expired':
      return {
        title: 'Чернетка застаріла — вона зберігається 24 години.',
        hint: 'Рядки вже видалено з сервера, тож відновити їх не можна. Надішліть файл ще раз.',
        canRetry: false,
      }
    case 'committed':
      return {
        title: 'Цей імпорт уже завершено, і змінити його не можна.',
        canRetry: false,
      }
    case 'conflict':
      return {
        title: 'Рядок змінився, поки ви з ним працювали.',
        hint: 'Ми перечитали чернетку. Перевірте рядок і повторіть дію, якщо вона ще потрібна.',
        canRetry: false,
      }
    case 'unauthorized':
      return { title: 'Потрібно увійти ще раз.', canRetry: false }
    case 'rate-limited':
      return {
        title: 'Забагато запитів поспіль.',
        hint: 'Зачекайте трохи й повторіть.',
        canRetry: true,
      }
    case 'file':
      return { title: failure.message, canRetry: false }
    case 'other':
      return { title: failure.message, canRetry: true }
  }
}
