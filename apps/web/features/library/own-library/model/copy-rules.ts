import type { OwnCopy, OwnerCopyStatus } from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import type { LibraryView } from '@/app/lib/use-library'

type CopyOwnership = Pick<OwnCopy, 'isHome' | 'status'>

/**
 * §5.1: `RESERVED` and `LENT_OUT` are set only by the loan state machine, so the toggle offers
 * exactly the two owner states. While the book is away it is unavailable: the server would answer
 * 409, and an honest "unavailable" beats a button that is guaranteed not to work.
 */
export function canToggleOwnerStatus(copy: CopyOwnership): boolean {
  return copy.isHome && (copy.status === 'AVAILABLE' || copy.status === 'UNAVAILABLE')
}

/** Both ways of recording a handover (to a friend, to a guest) start from a free copy that is at home. */
export function canRecordHandover(copy: CopyOwnership): boolean {
  return canToggleOwnerStatus(copy) && copy.status === 'AVAILABLE'
}

export function nextOwnerStatus(current: OwnCopy['status']): OwnerCopyStatus {
  return current === 'AVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE'
}

const EMPTY_SHELF_MESSAGES: Readonly<Record<LibraryView, string>> = {
  own: 'Полиця порожня. Знайдіть книжку в каталозі — і додайте примірник.',
  out: 'Усі ваші книжки вдома.',
  borrowed: 'Чужих книжок у вас зараз немає.',
  archive: 'Архів порожній.',
}

export function emptyMessage(view: LibraryView): string {
  return EMPTY_SHELF_MESSAGES[view]
}

/** What an action that failed shows: API errors as they are, anything else as a generic message. */
export function toFailure(error: unknown): Error {
  return error instanceof ApiRequestError ? error : new Error(describeError(error))
}
