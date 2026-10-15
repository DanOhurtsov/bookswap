import type { AddSearchOwnership } from '@bookswap/shared'
import type { ReactNode } from 'react'
import {
  quickAddActionsView,
  quickAddStatusText,
  type QuickAddButtonView,
} from '../model/quick-add-card'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { ghostButtonClass } from './screen-styles'

type QuickAddActionsProps = {
  /** Стан додавання цього видання в поточному сеансі. */
  slot: QuickAddSlot | undefined
  /** Видання вже в бібліотеці — `isOwned`. */
  owned: boolean
  /** `additional` — свідомо ще один фізичний примірник. */
  onAdd: (additional: boolean) => void
  onRetry: () => void
  /** Something on the screen must be finished first (an open correction): no action starts. */
  isBlocked?: boolean
  /** Further actions in the same row — «Уточнити дані», «Закрити». */
  children?: ReactNode
}

/**
 * Дії додавання одного видання — однакові для нашого й зовнішнього видання, у діалозі пошуку й у формі
 * уточнення, щоб усі представлення одного видання поводилися однаково.
 *
 * «Додано» — лише після підтвердженого сервером збереження. `aria-disabled`, а не `disabled`, на «Додаю…» і
 * «✓»: вимкнена кнопка випадає з порядку табуляції, і фокус, що стояв на ній, зникає. З тієї ж причини
 * основна кнопка — один елемент у всіх станах: фокус лишається на ній від «Додати» до «✓».
 */
export function QuickAddActions({
  slot,
  owned,
  onAdd,
  onRetry,
  isBlocked = false,
  children,
}: QuickAddActionsProps) {
  const view = quickAddActionsView(slot, owned)

  function run(target: QuickAddButtonView): void {
    if (isBlocked || target.busy) return

    if (target.command === 'add') onAdd(false)
    else if (target.command === 'addAnother') onAdd(true)
    else if (target.command === 'retry') onRetry()
  }

  return (
    <div>
      {slot?.status === 'unknown' && (
        <p className="alert alert--warn" role="alert">
          Не вдалося підтвердити додавання. Книжку не буде додано вдруге — перевірте ще раз.
        </p>
      )}

      {slot?.status === 'rejected' && (
        <p className="alert alert--error" role="alert">
          {slot.message}
        </p>
      )}

      {/* Always mounted: a live region announces only a change of what it already holds. */}
      <div role="status">
        {slot?.status === 'done' && (
          <p className="alert alert--ok">Книжку додано до вашої бібліотеки.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <QuickAddButton view={view.primary} isBlocked={isBlocked} onRun={run} />
        {view.secondary !== undefined && (
          <QuickAddButton
            view={view.secondary}
            isBlocked={isBlocked}
            isGhost={view.secondary.command !== 'retry'}
            onRun={run}
          />
        )}
        {children}
      </div>
    </div>
  )
}

type QuickAddButtonProps = {
  view: QuickAddButtonView
  isBlocked: boolean
  isGhost?: boolean
  onRun: (view: QuickAddButtonView) => void
}

function QuickAddButton({ view, isBlocked, isGhost = false, onRun }: QuickAddButtonProps) {
  const inert = isBlocked || view.busy || view.command === 'none'
  const ghost = isGhost || view.command === 'none'

  return (
    <button
      type="button"
      // See `ghostButtonClass`: a secondary button opts out of the global button rule to look secondary.
      {...(ghost ? { 'data-ui': 'button', className: ghostButtonClass } : {})}
      aria-disabled={inert}
      aria-busy={view.busy}
      onClick={() => {
        onRun(view)
      }}
    >
      {view.label}
    </button>
  )
}

type QuickAddStatusProps = {
  slot: QuickAddSlot | undefined
  ownership?: AddSearchOwnership | undefined
}

/** The card's short status; the actions themselves are in the dialog (BS-114). */
export function QuickAddStatus({ slot, ownership }: QuickAddStatusProps) {
  const text = quickAddStatusText(slot, ownership)

  return text === undefined ? null : <span className="book__meta font-semibold">{text}</span>
}
