import {
  addSearchExternalResponseSchema,
  addSearchRequestSchema,
  addSearchResponseSchema,
  bookLookupResponseSchema,
  quickAddResponseSchema,
  type AddSearchExternalItem,
  type AddSearchExternalResponse,
  type AddSearchResponse,
  type BookLookupResult,
  type QuickAddRequest,
  type QuickAddResponse,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'
import type { ExternalHalfResponse } from '../model/external-search-state'

/**
 * Локальна половина списку сторінки додавання: ОДНА картка — ОДНЕ конкретне видання.
 * `page` і `pageSize` надсилаються завжди явно: обидві половини списку мають питати ту саму
 * сторінку (як і в `searchExternalCatalogs`).
 */
export async function searchAddItems(
  query: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<AddSearchResponse> {
  const { q } = addSearchRequestSchema.parse({ q: query, page, pageSize })

  return apiRequest(
    `/me/library/add-search?q=${encodeURIComponent(q)}&page=${String(page)}&pageSize=${String(pageSize)}`,
    { schema: addSearchResponseSchema, ...(signal === undefined ? {} : { signal }) },
  )
}

/**
 * Автопошук, локальна половина: фіксований режим (до `AUTO_RESULT_LIMIT` елементів), без `page` і
 * `pageSize` — сервер відхилив би їх. Запит уже нормалізований викликачем.
 */
export async function suggestAddItems(
  query: string,
  signal?: AbortSignal,
): Promise<AddSearchResponse> {
  return apiRequest(`/me/library/add-search/suggest?q=${encodeURIComponent(query)}`, {
    schema: addSearchResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * Автопошук, зовнішня половина: сервер робить щонайбільше ОДИН запит до одного джерела й нічого не
 * дочитує. Клієнт не повторює відповідь `RATE_LIMITED`/збій — наступне питання лише від нової зміни тексту.
 */
export async function suggestAddExternal(
  query: string,
  signal?: AbortSignal,
): Promise<AddSearchExternalResponse> {
  return apiRequest(`/me/library/add-search/suggest/external?q=${encodeURIComponent(query)}`, {
    schema: addSearchExternalResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * Одна серверна операція «додати до бібліотеки». Повтор із тим самим `operationId` і тим самим
 * вмістом безпечний: сервер поверне вже створений примірник, а не додасть новий.
 */
export function quickAdd(request: QuickAddRequest): Promise<QuickAddResponse> {
  return apiRequest('/me/library/quick-add', {
    method: 'POST',
    body: request,
    schema: quickAddResponseSchema,
  })
}

/**
 * Зовнішня половина того самого списку. Записи, що вже є нашими виданнями, приходять локальними картками
 * (`EDITION`) — сервер підставляє їх ДО нарізання сторінки. Форма вирівняна під `ExternalHalfResponse`
 * (`results`), щоб один хук обслуговував і цей список, і `/catalog`.
 */
export async function searchAddExternal(
  query: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<ExternalHalfResponse<AddSearchExternalItem>> {
  const response = await apiRequest(
    `/me/library/add-search/external?q=${encodeURIComponent(query)}&page=${String(page)}&pageSize=${String(pageSize)}`,
    { schema: addSearchExternalResponseSchema, ...(signal === undefined ? {} : { signal }) },
  )

  return {
    results: response.items,
    sources: response.sources,
    page: response.page,
    pageSize: response.pageSize,
    more: response.more,
    complete: response.complete,
    ...(response.spellingSuggestion === undefined
      ? {}
      : { spellingSuggestion: response.spellingSuggestion }),
  }
}

/** Точний пошук за ISBN у зовнішніх джерелах: метадані для картки «Додати», ніщо не створюється. */
export async function lookupIsbn(isbn: string, signal?: AbortSignal): Promise<BookLookupResult> {
  const response = await apiRequest(`/catalog/lookup?isbn=${encodeURIComponent(isbn)}`, {
    schema: bookLookupResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })

  return response.result
}
