import { Injectable } from '@nestjs/common'
import { copyVisibleTo } from '../access/visibility'
import { PrismaService } from '../prisma/prisma.service'
import { AnalyticsService } from './analytics.service'

/**
 * `friend_inventory_became_usable` (Етап 9, §2): людина вперше отримала друга, у
 * якого є хоча б один видимий їй примірник `AVAILABLE` вдома. Подія одноразова на
 * людину (`domainEntityId` = її id, `dedupeKey` це й гарантує).
 *
 * Перевіряється лише в двох точках — прийнята дружба і додані власником книжки.
 * Друг, який пізніше змінить видимість чи звільнить примірник, нової події не
 * дає: вимірюється момент, коли мережа вперше стала корисною, а не постійний стан.
 *
 * Best-effort після коміту, як усе в `AnalyticsService`: жодна помилка не
 * повертається в доменну операцію.
 */
@Injectable()
export class NetworkActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Дружбу щойно прийнято: перевірити обидва напрямки. */
  async onFriendshipAccepted(userAId: string, userBId: string): Promise<void> {
    await this.check(userAId, userBId)
    await this.check(userBId, userAId)
  }

  /** Власник додав книжки: перевірити всіх його друзів, які ще не «активовані». */
  async onInventoryAdded(ownerId: string): Promise<void> {
    try {
      const friendships = await this.prisma.friendship.findMany({
        where: { status: 'ACCEPTED', OR: [{ userAId: ownerId }, { userBId: ownerId }] },
        select: { userAId: true, userBId: true },
      })
      const friendIds = friendships.map((row) =>
        row.userAId === ownerId ? row.userBId : row.userAId,
      )

      if (friendIds.length === 0) return

      const already = await this.prisma.productEvent.findMany({
        where: { type: 'FRIEND_INVENTORY_USABLE', subjectUserId: { in: friendIds } },
        select: { subjectUserId: true },
      })
      const done = new Set(already.map((row) => row.subjectUserId))

      for (const friendId of friendIds) {
        if (!done.has(friendId)) await this.check(friendId, ownerId)
      }
    } catch {
      // Аналітика не ламає доменну операцію (§3 плану 8a).
    }
  }

  private async check(viewerId: string, ownerId: string): Promise<void> {
    try {
      const owner = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { libraryVisibility: true },
      })

      if (owner === null) return

      const copies = await this.prisma.copy.findMany({
        where: { ownerId, status: 'AVAILABLE' },
        distinct: ['visibility'],
        select: { visibility: true },
      })

      if (
        !copies.some((copy) => copyVisibleTo('FRIEND', owner.libraryVisibility, copy.visibility))
      ) {
        return
      }

      await this.analytics.record({
        type: 'FRIEND_INVENTORY_USABLE',
        subjectUserId: viewerId,
        domainEntityId: viewerId,
        properties: {},
      })
    } catch {
      // див. вище
    }
  }
}
