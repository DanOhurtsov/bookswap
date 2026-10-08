import { LIBRARY_LIMITS, updateCopyRequestSchema } from '@bookswap/shared'

export type NoteDraftResult = { ok: true; note: string | null } | { ok: false; message: string }

/**
 * What the form sends for the text in the box. Validated by the same shared schema the API runs
 * on `PATCH /me/library/:id`, so the page cannot accept a note the server would refuse.
 *
 * A blank box means "no note": it clears the field (`null`) instead of storing whitespace. The
 * schema's only rule that text can break is the length, so that is the one message here.
 */
export function parseNoteDraft(text: string): NoteDraftResult {
  const trimmed = text.trim()

  if (trimmed === '') return { ok: true, note: null }

  const parsed = updateCopyRequestSchema.safeParse({ note: trimmed })

  if (!parsed.success) {
    return {
      ok: false,
      message: `Нотатка задовга: не більше ${String(LIBRARY_LIMITS.noteMax)} символів.`,
    }
  }

  return { ok: true, note: parsed.data.note ?? null }
}
