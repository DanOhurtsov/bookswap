import type { AddSearchOwnership, CopyEntryMethod, QuickAddTarget } from '@bookswap/shared'
import type { QuickAddSlot } from './quick-add-slots'
import type { QuickAddApi } from './use-quick-add'

/** What every result card with an "add to library" action receives. */
export interface QuickAddCardProps {
  slot: QuickAddSlot | undefined
  /** `additional` — deliberately one more physical copy. */
  onAdd: (additional: boolean) => void
  onRetry: () => void
}

/**
 * Binds one card to the add slot of its identities. Cards of the same edition share a slot, so they
 * share state and one request; the target says what the server is asked to add.
 */
export function quickAddCardProps(
  quick: QuickAddApi,
  entryMethod: CopyEntryMethod,
  identities: readonly string[],
  target: QuickAddTarget,
): QuickAddCardProps {
  return {
    slot: quick.slotFor(identities),
    onAdd: (additional) => {
      quick.add({ identities, entryMethod, additional, target })
    },
    onRetry: () => {
      quick.retry(identities)
    },
  }
}

/**
 * Whether the person already has this edition: the server said so (`ownership`) or an add of this
 * session was confirmed (`added` — it survives a later «ще один примірник» in flight). The one meaning
 * of "owned" for the card, the dialog and the edition form.
 */
export function isOwned(
  slot: QuickAddSlot | undefined,
  ownership: AddSearchOwnership | undefined,
): boolean {
  return (slot?.added ?? 0) > 0 || (ownership?.activeCount ?? 0) > 0
}

export type QuickAddCommand = 'add' | 'addAnother' | 'retry' | 'none'

export interface QuickAddButtonView {
  label: string
  command: QuickAddCommand
  /** A request is in flight: the button stays focusable but does nothing (`aria-disabled`). */
  busy: boolean
}

export interface QuickAddActionsView {
  /** One element through every state, so focus stays on it from «Додати» to «✓». */
  primary: QuickAddButtonView
  /** Only for an owned edition: one more physical copy is a separate, deliberate action. */
  secondary: QuickAddButtonView | undefined
  /**
   * «Уточнити дані» would start a different operation, so it is offered only while nothing is in flight
   * or unresolved — and not for an owned edition, where its add would silently be a second copy.
   */
  canRefine: boolean
}

const button = (label: string, command: QuickAddCommand, busy = false): QuickAddButtonView => ({
  label,
  command,
  busy,
})

/**
 * The add actions of one edition (docs/plan/fast-book-add.md, §2.2; BS-114). An unknown outcome allows
 * only checking the SAME operation again; «Додано» exists only after the server confirmed it.
 */
export function quickAddActionsView(
  slot: QuickAddSlot | undefined,
  owned: boolean,
): QuickAddActionsView {
  const pending = slot?.status === 'pending'
  const unknown = slot?.status === 'unknown'

  if (owned) {
    return {
      primary: button('✓ У моїй бібліотеці', 'none'),
      secondary: unknown
        ? button('Перевірити ще раз', 'retry')
        : button(pending ? 'Додаю…' : 'Додати ще один примірник', 'addAnother', pending),
      canRefine: false,
    }
  }

  return {
    primary: unknown
      ? button('Перевірити ще раз', 'retry')
      : pending
        ? button('Додаю…', 'none', true)
        : button('Додати до бібліотеки', 'add'),
    secondary: undefined,
    canRefine: !pending && !unknown,
  }
}

/** The card's short status line; the dialog has the full state and the actions. */
export function quickAddStatusText(
  slot: QuickAddSlot | undefined,
  ownership: AddSearchOwnership | undefined,
): string | undefined {
  if (slot?.status === 'pending') return 'Додаю…'
  if (slot?.status === 'unknown') return 'Додавання не підтверджено'
  if (isOwned(slot, ownership)) return '✓ У моїй бібліотеці'
  if (slot?.status === 'rejected') return 'Не вдалося додати'

  return (ownership?.archivedCount ?? 0) > 0 ? 'Є у вашому архіві' : undefined
}
