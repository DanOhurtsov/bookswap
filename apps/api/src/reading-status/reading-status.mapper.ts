import type { ReadingListItem } from '@bookswap/shared'
import { toWork, toWorkAuthors, type WorkAuthorRow, type WorkRow } from '../catalog/catalog.mapper'
import type { WorkReadingStatusModel } from '../generated/prisma/models'

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
