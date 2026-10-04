import { createHash } from 'node:crypto'
import type { QuickAddRequest } from '@bookswap/shared'

/**
 * Відбиток запиту для серверної ідемпотентності (docs/plan/fast-book-add.md, §5.2).
 *
 * Два запити з одним `operationId` — це ОДНА дія лише тоді, коли збігається і її вміст.
 * Відбиток береться з нормалізованого запиту без `operationId`: порядок ключів, `undefined`
 * і порожнє `copy` не повинні робити однакову дію «іншою».
 *
 * Приватна нотатка входить у хеш, але сам хеш не дозволяє її відновити (SHA-256) і в БД
 * нічого, крім нього, не лишається.
 */

/**
 * Значення, що відрізняються лише формою запису: відсутнє поле, `null` і порожній об'єкт
 * (`copy: {}`) — одне й те саме «нічого не задано».
 */
function isAbsent(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  )
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]): [string, unknown] => [key, canonical(item)])
        .filter(([, item]) => !isAbsent(item))
        .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0)),
    )
  }

  return value
}

export function requestHashOf(request: QuickAddRequest): string {
  const { operationId: _operationId, ...content } = request

  void _operationId

  const normalized = canonical({ ...content, entryMethod: content.entryMethod ?? 'MANUAL' })

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
