'use client'

import {
  copyHistoryResponseSchema,
  myHistoryResponseSchema,
  workHistoryResponseSchema,
  type CopyHistoryResponse,
  type MyHistoryResponse,
  type WorkHistoryResponse,
} from '@bookswap/shared'
import { useApiResource, type Resource } from './use-resource'

/**
 * §6.6: три в'ю однієї історії — примірника, твору й власна.
 *
 * Фронт нічого не приховує сам: рішення «з іменами чи без» ухвалює API за §9, і
 * коли імен бачити не належить, полів із ними у відповіді просто немає. Тому тут
 * лише завантаження — жодної фільтрації. Фільтрувати на клієнті означало б
 * завести другу реалізацію тієї самої матриці, яка одного дня розійдеться з
 * першою.
 */

/** §8: `GET /copies/:id/history` — усі лоани примірника в хронології. */
export function useCopyHistory(copyId: string): Resource<CopyHistoryResponse> {
  return useApiResource(`/copies/${encodeURIComponent(copyId)}/history`, copyHistoryResponseSchema)
}

/** §8: `GET /works/:id/history` — «Хто брав цю книжку» (Stage 10, Q16): передачі, а не прочитання. */
export function useWorkHistory(workId: string): Resource<WorkHistoryResponse> {
  return useApiResource(`/works/${encodeURIComponent(workId)}/history`, workHistoryResponseSchema)
}

/** §8: `GET /me/history` — «що я брав і що в мене брали». */
export function useMyHistory(): Resource<MyHistoryResponse> {
  return useApiResource('/me/history', myHistoryResponseSchema)
}
