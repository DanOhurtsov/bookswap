import { visibilitySchema, type Visibility } from '@bookswap/shared'
import type { QuickAddSlot } from './quick-add-slots'

/**
 * BS-79: a full add form's «Кому показувати» starts from the person's library visibility. The session
 * contract (`meSchema`) already requires a valid value, so the fallback is defense at the boundary where
 * the form is initialized — a malformed session stays a session error, it is never accepted here.
 */
const FALLBACK_COPY_VISIBILITY: Visibility = 'FRIENDS'

export function initialCopyVisibility(libraryVisibility: unknown): Visibility {
  const parsed = visibilitySchema.safeParse(libraryVisibility)

  return parsed.success ? parsed.data : FALLBACK_COPY_VISIBILITY
}

export type CopyVisibilityView =
  /** `''` — the operation on screen was sent without a choice: the server decides (`strictest(…, FRIENDS)`). */
  { value: Visibility | ''; isLocked: true } | { value: Visibility; isLocked: false }

/**
 * What the selector shows. While an operation is pending or unknown it shows the visibility that operation
 * was SENT with — also one restored after a reload — never the draft, so nothing on screen suggests the
 * operation could still change.
 *
 * After an unambiguous rejection the form is editable again and starts from what the rejected operation was
 * sent with. That matters for an operation restored after a reload: its form was mounted anew from the
 * profile and never saw the choice (BS-79). Only once: `madeAfter` is the rejected operation the person
 * changed the draft after, and from then on the draft is theirs. An operation sent without a visibility (the
 * search dialog) gives nothing back, and the draft stays.
 */
export function copyVisibilityView(
  slot: QuickAddSlot | undefined,
  draft: Visibility,
  madeAfter?: string,
): CopyVisibilityView {
  if (slot?.status === 'pending' || slot?.status === 'unknown') {
    return { value: slot.request.copy?.visibility ?? '', isLocked: true }
  }

  const rejected = rejectedOperationOf(slot)
  const sent = slot?.status === 'rejected' ? slot.request?.copy?.visibility : undefined

  if (rejected !== undefined && rejected !== madeAfter && sent !== undefined) {
    return { value: sent, isLocked: false }
  }

  return { value: draft, isLocked: false }
}

/** The rejected operation a change of the draft is made after — see `copyVisibilityView`. */
export function rejectedOperationOf(slot: QuickAddSlot | undefined): string | undefined {
  return slot?.status === 'rejected' ? slot.operationId : undefined
}
