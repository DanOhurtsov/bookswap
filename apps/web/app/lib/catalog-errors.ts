import type { ApiErrorCode } from '@bookswap/shared'
import { ApiRequestError, describeError } from './api'

/**
 * §11 і Етап 7b: 429/504/помилка провайдера — очікувані відповіді зовнішнього
 * світу, а не збій застосунку. Стандартний `error.message` із бекенду або
 * загальний рядок ThrottlerException не каже людині, що робити далі — тут це
 * робиться явно, з порадою заповнити форму вручну там, де це можливо.
 */
const FRIENDLY_MESSAGE_BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  TOO_MANY_REQUESTS: 'Забагато запитів поспіль. Зачекайте хвилину і спробуйте ще раз.',
  CATALOG_LOOKUP_TIMEOUT:
    'Зовнішній сервіс автозаповнення не відповів вчасно. Можна заповнити форму вручну.',
  CATALOG_LOOKUP_PROVIDER_ERROR:
    'Зовнішній сервіс автозаповнення зараз недоступний. Можна заповнити форму вручну.',
  LIBRARY_ADD_OPERATION_CONFLICT:
    'Це додавання вже виконувалося з іншими даними. Перезавантажте результати й спробуйте ще раз.',
  LIBRARY_ADD_RESULT_REMOVED: 'Примірник, доданий цією дією, уже видалено. Додайте книжку ще раз.',
  CATALOG_LOOKUP_NOT_FOUND:
    'За цим ISBN у зовнішньому джерелі нічого не знайшлося. Можна заповнити форму вручну.',
}

export function describeAddBookError(error: unknown): string {
  if (error instanceof ApiRequestError) return FRIENDLY_MESSAGE_BY_CODE[error.code] ?? error.message

  return describeError(error)
}
