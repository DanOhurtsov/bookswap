import type { FriendsReadingItem, ReadingListItem } from '@bookswap/shared'
import { toWork, toWorkAuthors, type WorkAuthorRow, type WorkRow } from '../catalog/catalog.mapper'
import { toPublicUser, type PublicUserRow } from '../users/user.mapper'
import type { WorkModel, WorkReadingStatusModel } from '../generated/prisma/models'

export type ReadingListRow = Pick<WorkReadingStatusModel, 'workId' | 'status' | 'updatedAt'> & {
  work: WorkRow & { authors: WorkAuthorRow[] }
}

/** Лише `READING`/`READ` потрапляють у список — це гарантує запит, тож тут звуження без `any`. */
export function toReadingListItem(
  row: ReadingListRow & { status: 'READING' | 'READ' },
  wasBorrowed: boolean,
): ReadingListItem {
  return {
    work: toWork(row.work),
    authors: toWorkAuthors(row.work.authors),
    status: row.status,
    wasBorrowed,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** BS-137: рівно те, що вибирає `ReadingStatusService.friendsReading` — ні повних моделей, ні приватних полів. */
export type FriendReadingRow = Pick<WorkReadingStatusModel, 'updatedAt'> & {
  user: PublicUserRow
  work: Pick<WorkModel, 'id' | 'title'> & {
    authors: WorkAuthorRow[]
    /** Не більше одного: перше видання з обкладинкою за `createdAt, id`. */
    editions: { coverUrl: string | null }[]
  }
}

export function toFriendsReadingItem(row: FriendReadingRow): FriendsReadingItem {
  return {
    friend: toPublicUser(row.user),
    work: { id: row.work.id, title: row.work.title },
    authors: toWorkAuthors(row.work.authors),
    coverUrl: row.work.editions[0]?.coverUrl ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}
