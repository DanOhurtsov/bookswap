import type { QuickAddSlot } from '../model/quick-add-slots'

type QuickAddActionsProps = {
  /** Стан додавання цього видання в поточному сеансі. */
  slot: QuickAddSlot | undefined
  /** Видання вже в бібліотеці: за відповіддю сервера або після підтвердженого додавання. */
  owned: boolean
  /** `additional` — свідомо ще один фізичний примірник. */
  onAdd: (additional: boolean) => void
  onRetry: () => void
}

/**
 * Дія додавання на картці — одна й та сама для локального й зовнішнього видання, щоб дві картки одного
 * видання поводилися однаково.
 *
 * «Додано» — лише після підтвердженого сервером збереження (`slot.status === 'done'`) або коли сервер уже
 * знає про примірник. `aria-disabled`, а не `disabled`, на кнопках «Додаю…» і «✓»: вимкнена кнопка випадає з
 * порядку табуляції, і фокус, що стояв на ній, зникає — клавіатурний користувач лишається нізвідки.
 */
export function QuickAddActions({ slot, owned, onAdd, onRetry }: QuickAddActionsProps) {
  const pending = slot?.status === 'pending'
  const unknown = slot?.status === 'unknown'

  return (
    <>
      {unknown && (
        <p className="alert alert--warn" role="alert">
          Не вдалося підтвердити додавання. Книжку не буде додано вдруге — перевірте ще раз.
        </p>
      )}

      {slot?.status === 'rejected' && (
        <p className="alert alert--error" role="alert">
          {slot.message}
        </p>
      )}

      {owned ? (
        <>
          <button type="button" aria-disabled="true" className="button--ghost">
            ✓ У моїй бібліотеці
          </button>
          <button
            type="button"
            className="button--ghost"
            aria-disabled={pending}
            onClick={() => {
              if (!pending) onAdd(true)
            }}
          >
            {pending ? 'Додаю…' : 'Додати ще один примірник'}
          </button>
        </>
      ) : unknown ? (
        <button type="button" onClick={onRetry}>
          Перевірити ще раз
        </button>
      ) : (
        <button
          type="button"
          aria-disabled={pending}
          aria-busy={pending}
          onClick={() => {
            if (!pending) onAdd(false)
          }}
        >
          {pending ? 'Додаю…' : 'Додати до бібліотеки'}
        </button>
      )}
    </>
  )
}
