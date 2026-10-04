import Link from 'next/link'
import type { QuickAddResponse } from '@bookswap/shared'

type QuickAddNoticeProps = {
  added: QuickAddResponse | undefined
  onCustomize: () => void
}

/**
 * Повідомлення про підтверджене збереження. Контейнер `role="status"` є в DOM завжди: екранний читач
 * озвучує зміни живої області, а не її появу. Користувач лишається в результатах — жодної навігації.
 */
export function QuickAddNotice({ added, onCustomize }: QuickAddNoticeProps) {
  return (
    <div role="status" aria-live="polite">
      {added !== undefined && (
        <div className="alert alert--ok">
          <p>«{added.work.title}» додано до бібліотеки.</p>
          <p>
            <Link href="/library">До бібліотеки</Link>{' '}
            <button
              type="button"
              className="button--ghost"
              aria-label={`Налаштувати примірник «${added.work.title}»`}
              onClick={onCustomize}
            >
              Налаштувати
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
