import { Injectable } from '@nestjs/common'
import {
  ACTIVATION_TARGET,
  activationNextActionFor,
  hasReachedActivationTarget,
  type ActivationResponse,
} from '@bookswap/shared'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Stage 8h-1, R11: how far the owner is from the first ten books.
 *
 * One `COUNT`, and nothing else. `LibraryService.listOwn()` answers the same
 * question, but it loads every copy together with its edition, translation,
 * work, authors, holder and open loans — a page of joins to arrive at a single
 * integer, and a page that grows with the shelf.
 *
 * Ownership here is `Copy.ownerId` alone. A book lent out, hidden from friends
 * or marked «temporarily not lending» is still a book on the shelf, so
 * `status`, `visibility` and `currentHolderId` deliberately take no part in the
 * count — otherwise the checklist would un-complete itself the moment somebody
 * borrowed the tenth book.
 *
 * Nothing is cached. The number has to survive an add, a repeat-add, an import
 * commit and a delete landing seconds apart, and the invalidation policy such a
 * cache would need is exactly the kind of subsystem R11 does not ask for.
 *
 * Analytics is not consulted either: `BOOK_ADDED` is best-effort and only ever
 * grows (§1 of the execution plan), while a deleted copy genuinely moves the
 * owner further from ten.
 */
@Injectable()
export class ActivationService {
  constructor(private readonly prisma: PrismaService) {}

  async progressOf(ownerId: string): Promise<ActivationResponse> {
    const ownedCopyCount = await this.prisma.copy.count({ where: { ownerId } })

    return {
      ownedCopyCount,
      target: ACTIVATION_TARGET,
      hasReachedTarget: hasReachedActivationTarget(ownedCopyCount),
      nextAction: activationNextActionFor(ownedCopyCount),
    }
  }
}
