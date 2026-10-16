'use client'

import type { QuickAddCopy, Visibility } from '@bookswap/shared'
import { useState } from 'react'
import {
  copyVisibilityView,
  initialCopyVisibility,
  rejectedOperationOf,
  type CopyVisibilityView,
} from './copy-visibility'
import type { QuickAddSlot } from './quick-add-slots'

export type CopyVisibilityDraft = CopyVisibilityView & {
  /** Changes only this form's draft — never the profile. Ignored while an operation is locked. */
  change: (visibility: Visibility) => void
  /** What every add from this form sends as `copy`: the shown visibility, always explicit. */
  copy: QuickAddCopy
}

interface Choice {
  visibility: Visibility
  /** The rejected operation this choice was made after: its sent visibility no longer shows. */
  madeAfter?: string
}

/**
 * The new copy's «Кому показувати» in a full add form (BS-79).
 *
 * Initialized ONCE, when the form mounts, from the library visibility the authenticated session holds at
 * that moment: a later profile update does not reset it, touched or not. A new form (a new intent, another
 * user) is a new mount and reads the preference anew. Mount it below the session guard.
 *
 * After a rejection the selector shows what the rejected operation was sent with until the person changes it
 * (`copyVisibilityView`) — derived from the slot, so a restored operation that is rejected at once needs no
 * effect or state sync to give its choice back.
 */
export function useCopyVisibilityDraft(
  libraryVisibility: Visibility,
  slot: QuickAddSlot | undefined,
): CopyVisibilityDraft {
  const [choice, setChoice] = useState<Choice>(() => ({
    visibility: initialCopyVisibility(libraryVisibility),
  }))
  const view = copyVisibilityView(slot, choice.visibility, choice.madeAfter)
  const madeAfter = rejectedOperationOf(slot)

  return {
    ...view,
    change: (visibility) => {
      if (!view.isLocked)
        setChoice(madeAfter === undefined ? { visibility } : { visibility, madeAfter })
    },
    // While locked nothing new is sent: a retry resends the operation's own frozen request.
    copy: { visibility: view.isLocked ? choice.visibility : view.value },
  }
}
