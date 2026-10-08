import { HttpStatus } from '@nestjs/common'
import { API_ERROR_CODES } from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import type { EditionTextResolution, EditionTextState } from './edition-language'

/** Суперечність мови: нічого не змінено, а `editionIds` каже, яких видань вона стосується. */
export function editionLanguageConflict(message: string, editionIds: string[] = []): ApiException {
  return new ApiException(
    API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT,
    message,
    HttpStatus.CONFLICT,
    editionIds.length === 0 ? undefined : { editionIds },
  )
}

/** Результат правил `resolveEditionText` — або новий стан, або явна помилка з машиночитним кодом. */
export function textOrThrow(resolution: EditionTextResolution): EditionTextState {
  if (resolution.ok) return resolution.state

  if (resolution.reason === 'LANGUAGE_CONFLICT') throw editionLanguageConflict(resolution.message)

  throw new ApiException(
    API_ERROR_CODES.EDITION_TEXT_KIND_CONFLICT,
    resolution.message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    { reason: resolution.reason },
  )
}
