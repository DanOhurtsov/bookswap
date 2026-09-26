'use client'

import {
  borrowedLibraryResponseSchema,
  libraryResponseSchema,
  visibleLibraryResponseSchema,
  type BorrowedLibraryResponse,
  type LibraryQueryRequest,
  type LibraryResponse,
  type VisibleLibraryResponse,
} from '@bookswap/shared'
import { useApiResource, type Resource } from './use-resource'

/**
 * §6.4: три в'ю однієї бібліотеки — «мої», «мої не вдома», «чужі в мене».
 *
 * Хуки два, а не один, і це не дублювання: «чужі в мене» віддає інший тип
 * примірника (там видно власника, але не його нотатки) і не має жодної мутації.
 * Один хук на обидва випадки або повертав би union, який довелося б звужувати
 * приведенням типу, або вдавав би, що дві різні відповіді — одна.
 */
export type LibraryView = 'own' | 'out' | 'borrowed' | 'archive'

const OWN_PATHS = {
  own: '/me/library',
  out: '/me/library/out',
  archive: '/me/library?archived=true',
} as const

/** Фільтри §8 у рядок запиту. Порожні значення не додаються — це «без фільтра». */
function toQuery(filters: LibraryQueryRequest): string {
  const parameters = new URLSearchParams()

  if (filters.status !== undefined) parameters.set('status', filters.status)
  if (filters.lang !== undefined) parameters.set('lang', filters.lang)
  if (filters.q !== undefined) parameters.set('q', filters.q)

  const query = parameters.toString()

  return query === '' ? '' : `?${query}`
}

/** §8: `GET /me/library`, `/me/library/out` і (Stage 10) `?archived=true`. Фільтри — лише в першої. */
export function useOwnLibrary(
  view: 'own' | 'out' | 'archive',
  filters: LibraryQueryRequest,
): Resource<LibraryResponse> {
  // Фільтри — обʼєкт, тож ключем стає рядок запиту, а не він сам: новий літерал
  // на кожен рендер перезапускав би завантаження нескінченно.
  const query = view === 'own' ? toQuery(filters) : ''

  return useApiResource(`${OWN_PATHS[view]}${query}`, libraryResponseSchema)
}

/** §6.4, в'ю «Чужі книжки в мене»: `currentHolderId = me AND ownerId ≠ me`. */
export function useBorrowedLibrary(): Resource<BorrowedLibraryResponse> {
  return useApiResource('/me/library/borrowed', borrowedLibraryResponseSchema)
}

/**
 * Бібліотека іншої людини. Рішення «чи можна це бачити» ухвалює API (§9), тож
 * фронт не фільтрує нічого — він показує рівно те, що приїхало.
 *
 * Перезавантаження потрібне кнопці «Попросити» (§6.5): після надісланого запиту
 * примірник лишається `AVAILABLE` (§5.1), і єдине, що змінюється, — `canRequest`
 * та `myActiveLoan` у відповіді.
 */
export function useFriendLibrary(userId: string): Resource<VisibleLibraryResponse> {
  return useApiResource(
    `/users/${encodeURIComponent(userId)}/library`,
    visibleLibraryResponseSchema,
  )
}
