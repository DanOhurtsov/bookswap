import { quickAddRequestSchema, type QuickAddRequest } from '@bookswap/shared'
import { z } from 'zod'

/**
 * Незавершені додавання переживають перезавантаження сторінки (`sessionStorage`).
 *
 * Зберігається лише те, що потрібно для ПОВТОРУ ТІЄЇ САМОЇ операції: слот, `operationId`, заморожений
 * запит. Ключ містить ідентифікатор користувача: чужий запис не повторюється під іншою сесією.
 * `sessionStorage` може бути недоступний (приватне вікно, заблоковані дані) — тоді все працює без нього.
 */
const STORAGE_KEY_PREFIX = 'bookswap.quick-add.'

const entrySchema = z.object({
  operationId: z.uuid(),
  identities: z.array(z.string()).min(1),
  request: quickAddRequestSchema,
})

const stateSchema = z.record(z.string(), entrySchema)

export interface PendingEntry {
  operationId: string
  identities: string[]
  request: QuickAddRequest
}

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`
}

export function readPending(userId: string): Record<string, PendingEntry> {
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId))

    if (raw === null) return {}

    const parsed = stateSchema.safeParse(JSON.parse(raw))

    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function write(userId: string, value: Record<string, PendingEntry>): void {
  try {
    if (Object.keys(value).length === 0) window.sessionStorage.removeItem(storageKey(userId))
    else window.sessionStorage.setItem(storageKey(userId), JSON.stringify(value))
  } catch {
    // Без сховища повтор після перезавантаження просто недоступний.
  }
}

export function rememberPending(userId: string, key: string, entry: PendingEntry): void {
  write(userId, { ...readPending(userId), [key]: entry })
}

export function forgetPending(userId: string, key: string): void {
  const { [key]: _removed, ...rest } = readPending(userId)

  void _removed
  write(userId, rest)
}
