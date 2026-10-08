import { HttpStatus } from '@nestjs/common'
import { API_ERROR_CODES } from '@bookswap/shared'
import { ApiException } from '../common/api.exception'

/**
 * Курсор списку читання — позиція в порядку `(updatedAt DESC, id DESC)`. Непрозорий для клієнта:
 * base64url від `[updatedAtISO, id]`. Пара, а не лише час, бо кілька рядків можуть мати однаковий
 * `updatedAt`, і без `id` сторінка гублювала б або дублювала їх.
 */
export interface ReadingListCursor {
  updatedAt: Date
  id: string
}

export function encodeCursor(cursor: ReadingListCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt.toISOString(), cursor.id])).toString(
    'base64url',
  )
}

export function decodeCursor(raw: string): ReadingListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

    if (Array.isArray(parsed) && parsed.length === 2) {
      const [iso, id] = parsed as unknown[]
      const updatedAt = typeof iso === 'string' ? new Date(iso) : null

      if (
        updatedAt !== null &&
        !Number.isNaN(updatedAt.getTime()) &&
        updatedAt.toISOString() === iso &&
        typeof id === 'string' &&
        id.length > 0
      ) {
        return { updatedAt, id }
      }
    }
  } catch {
    // Невалідний JSON — та сама відповідь, що й для хибної форми.
  }

  throw new ApiException(
    API_ERROR_CODES.VALIDATION_ERROR,
    'Недійсний курсор',
    HttpStatus.BAD_REQUEST,
  )
}
