'use client'

type RefreshNoticeProps = {
  message: string
  onRetry: () => void
  onDismiss: () => void
}

/**
 * R12: a failed background refresh after a successful PATCH is not a failed
 * save — it gets its own soft notice, not `FormStatus`'s error styling, and a
 * manual retry that re-runs the GET (`reload()`), never the PATCH again.
 */
export function RefreshNotice({ message, onRetry, onDismiss }: RefreshNoticeProps) {
  return (
    <div className="alert alert--warn" role="status">
      <p>Зміни збережено. Не вдалося оновити сторінку повністю: {message}</p>
      <div className="person__actions">
        <button type="button" className="button--ghost" onClick={onRetry}>
          Оновити сторінку
        </button>
        <button type="button" className="button--ghost" onClick={onDismiss}>
          Гаразд
        </button>
      </div>
    </div>
  )
}
