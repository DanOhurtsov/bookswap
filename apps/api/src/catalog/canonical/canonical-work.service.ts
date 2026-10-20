import { HttpStatus, Injectable } from '@nestjs/common'
import { API_ERROR_CODES } from '@bookswap/shared'
import { ApiException } from '../../common/api.exception'
import { PrismaService } from '../../prisma/prisma.service'

/** Where a request addressed to `requestedWorkId` actually lands. */
export interface CanonicalWork {
  /** The work that answers for the request. Always canonical. */
  workId: string
  requestedWorkId: string
  /** Whether the two differ — i.e. whether the requested work was merged away. */
  moved: boolean
}

/**
 * §6.3, stage 7h: resolving a `Work` id to the record that answers for it.
 *
 * A merged `Work` is never deleted (§6.3) — it keeps `mergedIntoId` while all of
 * its `Edition`, `Translation`, `Review` and `WishlistItem` rows move to the
 * target. Without this resolver a link to a merged work would render an empty
 * page: the title survives, everything under it is gone.
 *
 * Resolution is a single lookup, not a loop, and that is not an optimisation —
 * it is invariant R4, held by `merge.service.ts` on the write side:
 * `assertMergeable` refuses a merge whose source or target is already merged,
 * and `incomingMergesRepointed` rewrites every incoming `mergedIntoId` to the
 * new target. So `mergedIntoId` always names a canonical work, and a chain
 * longer than one hop cannot be created in the first place. Walking a chain here
 * would be dead code that quietly licenses the invariant to rot.
 */
@Injectable()
export class CanonicalWorkService {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws `NOT_FOUND` when the work does not exist at all. */
  async resolve(requestedWorkId: string): Promise<CanonicalWork> {
    const work = await this.prisma.work.findUnique({
      where: { id: requestedWorkId },
      select: { id: true, mergedIntoId: true },
    })

    if (work === null) {
      throw new ApiException(API_ERROR_CODES.NOT_FOUND, 'Твір не знайдено', HttpStatus.NOT_FOUND)
    }

    return {
      workId: work.mergedIntoId ?? work.id,
      requestedWorkId,
      moved: work.mergedIntoId !== null,
    }
  }

  /**
   * {@link resolve} for many ids in one query (BS-140). An id that names no work is absent from the
   * map instead of failing the rest: a batch answers for what exists.
   */
  async resolveMany(requestedWorkIds: readonly string[]): Promise<Map<string, string>> {
    if (requestedWorkIds.length === 0) return new Map()

    const works = await this.prisma.work.findMany({
      where: { id: { in: [...requestedWorkIds] } },
      select: { id: true, mergedIntoId: true },
    })

    return new Map(works.map((work) => [work.id, work.mergedIntoId ?? work.id]))
  }

  /**
   * The write-side counterpart of {@link resolve}: refuses instead of redirecting.
   *
   * A write is not silently retargeted. Creating a `Translation` or an `Edition`
   * on a merged work would be worse than refusing — reads resolve to the
   * canonical record, so the new row would be invisible from the moment it was
   * written, and nobody would learn about it. Retargeting it silently is no
   * better: the client would have written to a record it never named.
   */
  async assertCanonical(requestedWorkId: string): Promise<void> {
    const resolved = await this.resolve(requestedWorkId)

    if (resolved.moved) throw workMergedConflict(resolved)
  }
}

/** HTTP 409 carrying the work to retarget to — see `API_ERROR_CODES.WORK_MERGED`. */
export function workMergedConflict(resolved: CanonicalWork): ApiException {
  return new ApiException(
    API_ERROR_CODES.WORK_MERGED,
    `Твір злито у ${resolved.workId}`,
    HttpStatus.CONFLICT,
    { canonicalWorkId: resolved.workId, requestedWorkId: resolved.requestedWorkId },
  )
}
