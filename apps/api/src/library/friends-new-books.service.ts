import { Injectable } from '@nestjs/common'
import {
  FRIENDS_NEW_BOOKS_LIMITS,
  VISIBILITY,
  type FriendsNewBook,
  type FriendsNewBooksResponse,
  type Visibility,
} from '@bookswap/shared'
import { AccessService } from '../access/access.service'
import { isVisibleTo } from '../access/visibility'
import { toWorkAuthors } from '../catalog/catalog.mapper'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../users/user.mapper'

/**
 * §9 for a friend, as the SQL below needs it. A copy is seen when the stricter of the library's and
 * the copy's visibility is open to friends (`copyVisibleTo`); strictness is a scale, so that is «both
 * are open to friends». Derived from the matrix, not restated: the feed cannot drift from it.
 */
export const VISIBLE_TO_FRIENDS: readonly Visibility[] = VISIBILITY.filter((visibility) =>
  isVisibleTo('FRIEND', visibility),
)

/**
 * BS-147: «Нове в бібліотеках друзів». The newest additions (`Copy.createdAt`) to the libraries of the
 * viewer's friends, one card per friend and canonical work.
 *
 * Who counts is `AccessService.acceptedFriendIds`: an `ACCEPTED` pair only, so a pending request, a
 * friend of a friend and a blocked pair (the same `Friendship` row, `BLOCKED`) never do, nor the viewer.
 * Which copies count: not archived, `AVAILABLE` (at home — `copy_available_is_home`), and visible to a
 * friend by the library and the copy together. A loan, a return or an edit does not touch `createdAt`,
 * so none of them makes a book new again.
 *
 * All of that, the grouping and the per-friend cap run in one query, before the overall limit: a friend
 * who imported a whole shelf takes three places, and older books of other friends fill the rest. The
 * cards are then read in one more query — never per friend or per book.
 */
@Injectable()
export class FriendsNewBooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async list(viewerId: string): Promise<FriendsNewBooksResponse> {
    const friendIds = await this.access.acceptedFriendIds(viewerId)

    if (friendIds.length === 0) return { hasFriends: false, items: [] }

    const copyIds = await this.newestCopyIds(friendIds)

    return { hasFriends: true, items: await this.cards(copyIds) }
  }

  /**
   * One copy per (friend, work) — its newest eligible one — then at most `perFriend` per friend, then
   * at most `total`, newest first. `id` breaks every tie, so the same data always gives the same feed.
   * A merged work keeps no editions (`MergeService` moves them), so `Edition.workId` is the canonical
   * work; the `mergedIntoId` check only keeps a half-merged row out.
   */
  private async newestCopyIds(friendIds: string[]): Promise<string[]> {
    // Compared as the enum, not as text: a cast on the column hides it from the planner's statistics,
    // and on a few hundred friends the plan fell from a hash join to a nested loop over every user.
    const visibleToFriends = Prisma.join(
      VISIBLE_TO_FRIENDS.map((visibility) => Prisma.sql`${visibility}::"Visibility"`),
    )
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH eligible AS (
        SELECT c."id", c."ownerId", e."workId", c."createdAt"
        FROM "Copy" c
        JOIN "User" u ON u."id" = c."ownerId"
        JOIN "Edition" e ON e."id" = c."editionId"
        JOIN "Work" w ON w."id" = e."workId"
        WHERE c."ownerId" IN (${Prisma.join(friendIds)})
          AND c."status" = 'AVAILABLE'
          AND c."archivedAt" IS NULL
          AND c."visibility" IN (${visibleToFriends})
          AND u."libraryVisibility" IN (${visibleToFriends})
          AND w."mergedIntoId" IS NULL
      ),
      newest AS (
        SELECT DISTINCT ON ("ownerId", "workId") "id", "ownerId", "createdAt"
        FROM eligible
        ORDER BY "ownerId", "workId", "createdAt" DESC, "id" DESC
      ),
      ranked AS (
        SELECT "id", "createdAt",
          ROW_NUMBER() OVER (PARTITION BY "ownerId" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
        FROM newest
      )
      SELECT "id" FROM ranked
      WHERE "rank" <= ${FRIENDS_NEW_BOOKS_LIMITS.perFriend}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${FRIENDS_NEW_BOOKS_LIMITS.total}
    `

    return rows.map((row) => row.id)
  }

  /** The cards of `copyIds`, in their order. A copy gone since the first query is simply left out. */
  private async cards(copyIds: string[]): Promise<FriendsNewBook[]> {
    if (copyIds.length === 0) return []

    const copies = await this.prisma.copy.findMany({
      where: { id: { in: copyIds } },
      select: {
        id: true,
        createdAt: true,
        owner: { select: PUBLIC_USER_FIELDS },
        edition: {
          select: {
            coverUrl: true,
            work: {
              select: {
                id: true,
                title: true,
                authors: {
                  select: {
                    role: true,
                    position: true,
                    author: { select: { id: true, name: true, nameLatin: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    const byId = new Map(copies.map((copy) => [copy.id, copy]))

    return copyIds.flatMap((id) => {
      const copy = byId.get(id)

      if (copy === undefined) return []

      const { work } = copy.edition

      return [
        {
          friend: toPublicUser(copy.owner),
          work: { id: work.id, title: work.title },
          authors: toWorkAuthors(work.authors),
          coverUrl: copy.edition.coverUrl,
          addedAt: copy.createdAt.toISOString(),
        },
      ]
    })
  }
}
