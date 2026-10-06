import type { CopyEntryMethod, QuickAddTarget } from '@bookswap/shared'
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
