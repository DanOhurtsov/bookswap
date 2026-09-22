import Link from 'next/link'
import { ActivationChecklist } from '@/features/library/activation/index.client'

type AddBookSuccessProps = {
  title: string
  workId: string
  onRepeatEdition: () => void
  onAddNext: () => void
  onScanNext: () => void
}

export function AddBookSuccess({
  title,
  workId,
  onRepeatEdition,
  onAddNext,
  onScanNext,
}: AddBookSuccessProps) {
  return (
    <>
      <div className="alert alert--ok" role="status">
        <p>«{title}» тепер у вашій бібліотеці.</p>
      </div>
      <div className="actions" aria-label="Додати ще">
        <button type="button" onClick={onRepeatEdition}>
          Ще один такий примірник
        </button>
        <button type="button" onClick={onAddNext}>
          Додати наступну книгу
        </button>
        <button type="button" onClick={onScanNext}>
          Сканувати наступну
        </button>
      </div>
      {/* Stage 8h-2 (R11): the same checklist as the library page, reading the
          same `['activation']` query — the copy just added has already
          invalidated it, so this shows the new count rather than a private
          recount of its own. */}
      <ActivationChecklist />

      <p className="form__aside">
        <Link href="/library">До бібліотеки</Link> ·{' '}
        <Link href={`/works/${workId}`}>Сторінка твору</Link>
      </p>
    </>
  )
}
