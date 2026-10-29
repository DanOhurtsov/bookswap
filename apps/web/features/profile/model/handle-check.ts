import { handleSchema, type HandleAvailability } from '@bookswap/shared'

/** The pause after the last keystroke before a nickname is checked (canvas spec: 400 ms). */
export const HANDLE_CHECK_DELAY_MS = 400

export type HandleCheckTone = 'muted' | 'ok' | 'error'

export interface HandleCheckView {
  message: string
  tone: HandleCheckTone
  /** «Зберегти» waits: the nickname is wrong, taken, or not yet known to be free (PO, 27.10.2026). */
  blocksSave: boolean
  /** The check failed on its own (network, rate limit): it can be asked again. */
  canRetry: boolean
}

export interface HandleCheckInput {
  /** The saved nickname. */
  current: string
  /** What the field holds now. */
  draft: string
  /** The nickname the pause has passed for — the one the answer below belongs to. */
  asked: string | undefined
  answer: { data: HandleAvailability | undefined; isError: boolean; isFetching: boolean }
}

/**
 * What the line under the nickname says. An answer counts only for the nickname in the field now: one
 * that arrives for an earlier text is never shown as this one's.
 */
export function handleCheckView({
  current,
  draft,
  asked,
  answer,
}: HandleCheckInput): HandleCheckView {
  const parsed = handleSchema.safeParse(draft)

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? ''

    return { message, tone: 'error', blocksSave: true, canRetry: false }
  }

  if (parsed.data === current) {
    return { message: 'Це ваш поточний нік', tone: 'muted', blocksSave: false, canRetry: false }
  }

  if (asked !== parsed.data || answer.isFetching) {
    return { message: 'Перевіряємо…', tone: 'muted', blocksSave: true, canRetry: false }
  }

  if (answer.isError || answer.data === undefined) {
    return { message: 'Не вдалося перевірити нік', tone: 'error', blocksSave: true, canRetry: true }
  }

  return answer.data.available
    ? { message: '✓ Нік вільний', tone: 'ok', blocksSave: false, canRetry: false }
    : { message: 'Цей нік уже зайнятий', tone: 'error', blocksSave: true, canRetry: false }
}

/** The nickname worth asking the server about: well-formed and not the saved one. */
export function handleToAsk(current: string, draft: string): string | undefined {
  const parsed = handleSchema.safeParse(draft)

  return parsed.success && parsed.data !== current ? parsed.data : undefined
}
