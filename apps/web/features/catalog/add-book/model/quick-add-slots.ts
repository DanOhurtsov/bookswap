import type { QuickAddRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'

/**
 * Стан додавання ОДНОГО видання (docs/plan/fast-book-add.md, §2.2, §6; ред. 2, правка 4).
 *
 * Слот один на видання, а не на картку: усі відомі ідентичності цього видання (`edition:<id>`,
 * `isbn:<…>`, `gb:<…>`) вказують на той самий слот, тож дві картки одного видання не можуть
 * запустити двох незалежних операцій.
 *
 * Життєвий цикл:
 * - `pending` — запит у польоті; повторне натискання ігнорується.
 * - `unknown` — результат невідомий (мережа, timeout, 5xx, 429). Дозволений лише повтор ТІЄЇ САМОЇ
 *   операції з незмінним вмістом: сервер поверне вже створений примірник або створить його, але
 *   зайвого не додасть. Нова операція заборонена, доки результат не з'ясовано.
 * - `rejected` — однозначна відмова (4xx). Виправлена дія може почати НОВУ операцію.
 * - `done` — збережено; `added` — скільки примірників цього видання додано в цьому сеансі.
 */
export type QuickAddSlot =
  | { status: 'pending'; operationId: string; request: QuickAddRequest; added: number }
  | {
      status: 'unknown'
      operationId: string
      request: QuickAddRequest
      added: number
      message: string
    }
  | {
      status: 'rejected'
      added: number
      message: string
      /** Машиночитний код відмови й його `details` — щоб форма могла показати конкретну дію (наявне видання за ISBN). */
      code?: string
      details?: unknown
    }
  | { status: 'done'; added: number; copyId: string; editionId: string }

export interface QuickAddSlotsState {
  slots: Readonly<Record<string, QuickAddSlot>>
  /** Ідентичність → ключ слота. */
  aliases: Readonly<Record<string, string>>
}

export const EMPTY_SLOTS: QuickAddSlotsState = { slots: {}, aliases: {} }

export type QuickAddSlotsAction =
  | {
      type: 'started'
      key: string
      identities: readonly string[]
      operationId: string
      request: QuickAddRequest
    }
  | { type: 'unknown'; key: string; message: string }
  | { type: 'rejected'; key: string; message: string; code?: string; details?: unknown }
  | { type: 'done'; key: string; identities: readonly string[]; copyId: string; editionId: string }

/** Ключ слота для набору ідентичностей: перший, що вже відомий, інакше перша з набору. */
export function slotKeyOf(state: QuickAddSlotsState, identities: readonly string[]): string {
  for (const identity of identities) {
    const known = state.aliases[identity]

    if (known !== undefined) return known
  }

  const [first] = identities

  if (first === undefined) throw new Error('Слот потребує хоча б однієї ідентичності видання')

  return first
}

export function slotOf(
  state: QuickAddSlotsState,
  identities: readonly string[],
): QuickAddSlot | undefined {
  return state.slots[slotKeyOf(state, identities)]
}

function withAliases(
  aliases: QuickAddSlotsState['aliases'],
  key: string,
  identities: readonly string[],
): QuickAddSlotsState['aliases'] {
  return {
    ...aliases,
    ...Object.fromEntries([key, ...identities].map((identity) => [identity, key])),
  }
}

export function quickAddSlotsReducer(
  state: QuickAddSlotsState,
  action: QuickAddSlotsAction,
): QuickAddSlotsState {
  const current = state.slots[action.key]
  const added = current?.added ?? 0

  switch (action.type) {
    case 'started':
      return {
        slots: {
          ...state.slots,
          [action.key]: {
            status: 'pending',
            operationId: action.operationId,
            request: action.request,
            added,
          },
        },
        aliases: withAliases(state.aliases, action.key, action.identities),
      }

    case 'unknown':
      // Лише з `pending`: «невідомо» не може з'явитися з нічого.
      if (current?.status !== 'pending') return state

      return {
        ...state,
        slots: {
          ...state.slots,
          [action.key]: {
            status: 'unknown',
            operationId: current.operationId,
            request: current.request,
            added,
            message: action.message,
          },
        },
      }

    case 'rejected':
      return {
        ...state,
        slots: {
          ...state.slots,
          [action.key]: {
            status: 'rejected',
            added,
            message: action.message,
            ...(action.code === undefined ? {} : { code: action.code }),
            ...(action.details === undefined ? {} : { details: action.details }),
          },
        },
      }

    case 'done':
      return {
        slots: {
          ...state.slots,
          [action.key]: {
            status: 'done',
            added: added + 1,
            copyId: action.copyId,
            editionId: action.editionId,
          },
        },
        // Після успіху всі представлення цього видання (зокрема за `editionId`) показують один стан.
        aliases: withAliases(state.aliases, action.key, [
          ...action.identities,
          `edition:${action.editionId}`,
        ]),
      }
  }
}

/**
 * Однозначна відмова чи невідомий результат.
 *
 * Однозначною вважається лише відповідь 4xx (окрім 408 і 429): сервер сказав «ні» щодо цього
 * запиту, і повтор нічого не змінить. Усе інше — обрив мережі, timeout, 5xx, 429, відповідь, що не
 * розібралася, — не доводить, що примірник НЕ створено, тож лишається повтор тієї ж операції.
 */
export function classifyFailure(error: unknown): 'rejected' | 'unknown' {
  if (!(error instanceof ApiRequestError)) return 'unknown'
  if (error.status === 408 || error.status === 429) return 'unknown'

  return error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown'
}

/** UUID v4. `crypto.randomUUID` є лише в безпечному контексті, тож є запасний шлях. */
export function newOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)

  crypto.getRandomValues(bytes)

  // Версія 4 і варіант RFC 4122.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
